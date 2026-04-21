# Cursor-driven loops — implementation status

*Companion to [noetl_cursor_loop_design.md](noetl_cursor_loop_design.md).
Captures the delivered infrastructure, the gotchas hit during PFT
validation, and what remains.*

## Goal recap

The design document describes *why* cursor-driven loops matter — the
collection-materialized `step.loop` primitive was producing CAS
exhaustion stalls, reference-only replay failures, ~13-16 events per
iteration, multi-MB NATS KV blobs at loop-start, and required
`_find_missing_loop_iteration_indices` tail-repair to paper over
missing terminals.

The proposal: keep the `step.loop` container, add a new **source**
(`loop.cursor`) alongside `loop.in`. A cursor-driven loop is a
pull-model worker pool — the engine dispatches *N = max_in_flight*
persistent worker commands up front, each worker opens a driver
handle and loops `claim → render iter.<iterator> → run task chain →
repeat` until the driver's claim returns zero rows. The engine stops
participating in per-iteration CAS bookkeeping; atomicity lives in
the driver's claim statement
(`UPDATE ... FOR UPDATE SKIP LOCKED RETURNING` for postgres).

Success criteria remain unchanged:

1. PFT flow runs 10 facilities × 1000 patients × 5 data types to
   10/10 green with no tail-repair intervention.
2. Event count drops ~10× relative to the collection-based loop.
3. Authors can target new backends (MySQL, Snowflake, ClickHouse,
   Redis streams, S3 prefix listings) by registering a new driver
   without engine changes.

## Delivered scope

### Infrastructure (Phases 1–5, merged on `feat/storage-rw-alignment-phase-1`)

| Phase | What | Commit |
|---|---|---|
| 1 | Pydantic `CursorSpec`, `Loop` extension, mutual-exclusion validator | `83c88204` |
| 2 | `noetl.core.cursor_drivers` registry + `PostgresCursorDriver` (psycopg_pool-backed) | `83c88204` |
| 3 | `_issue_cursor_loop_commands` dispatching N worker commands, no CAS | `5583ec77`, `f4a8b160` |
| 4 | `noetl/worker/cursor_worker.py` runtime with `claim → task_sequence → repeat` loop | `d99294a5` |
| 5 | `loop.done` aggregation: cursor-aware guards in `events.py` / `rendering.py` | `aad1f363` |

Key design choices that survived validation:

- **Command naming**: cursor worker commands use `step:task_sequence`
  suffix (not a bespoke `:cursor_worker`) so the engine's existing
  `call.done → try_record_loop_iteration_terminal → loop.done`
  aggregation path fires without a parallel code path. The cursor
  runtime is selected via `tool.kind = "cursor_worker"` on the
  command; the step name suffix is purely a routing key.
- **Per-worker loop_iteration_index**: each slot is stamped with its
  slot index so the NATS KV completed-count reaches
  `scheduled_count = worker_count` when all slots exit. Loop.done
  fires on the last slot's terminal event.
- **Synthetic collection**: `loop_state[step].collection = range(N)`
  with `collection_size = N`. Cursor-aware branches in
  `events.py` / `rendering.py` skip the `loop.in_` re-render path
  (cursor loops have no `in_` to render) and skip tail-repair
  (mid-flight crashes are handled by the driver's reclaim prelude,
  not by the engine).

### PFT playbook migration (Phase 6, commit `9f82ab0f`)

Five `fetch_X` loops collapsed from a 3-step `load_patients_for_X →
claim_patients_for_X → fetch_X` per data type into a single cursor
loop. Step count dropped 35 → 24. Each `fetch_X.loop.cursor.claim`
combines a 5-minute stale-claim reclaim CTE with a
`FOR UPDATE SKIP LOCKED LIMIT 1` candidate select, so one SQL
statement per claim. `mark_X_done` retains a retry arc (`when:
data_count < patients_per_facility → fetch_X`) so a crashed worker's
incomplete facility can re-drain without manual intervention.

### Gotchas solved along the way

Each of these showed up once the cursor loop hit the PFT multi-
facility test and required a dedicated fix:

1. **Shared Postgres pool per process** (commit `47397c94`). The
   initial driver opened an independent `AsyncConnectionPool` per
   cursor_worker command. With five data types × 100 slots, the
   first multi-facility run blew past Postgres `max_connections`
   almost immediately (`sorry, too many clients already`). Now one
   pool per `(DSN, event-loop)` in a module-level registry, sized to
   `cursor.options.pool_size` (default 8).
2. **Step suffix `:task_sequence`** (commit `f0ce4c31`). The engine's
   `call.done → loop.done` aggregation path at `events.py:216` only
   fires for `step:task_sequence`-suffixed steps. Initial cursor
   dispatch used `:cursor_worker` suffix, so 100 call.done events
   fired per epoch but loop.done never did.
3. **Seed NATS KV loop_state at dispatch** (commit `440c21f0`).
   `increment_loop_completed` needs a pre-seeded distributed entry to
   increment against; `_create_command_for_step` seeds it for normal
   loops but cursor dispatch bypassed that path. First call.done
   hit `new_count = -1`, fell back to the event-count path, which
   explicitly skips the `loop.done` claim. Loop.done never fired.
4. **Clear completed_steps on re-entry** (commit `fa21d8ea`).
   Non-cursor loops clear prior completion snapshot inside
   `_create_command_for_step`'s `should_reset_existing_loop` branch.
   Cursor dispatch skipped that path. On re-entry from
   `mark_facility_processed → load_next_facility →
   setup_facility_work → fetch_X` for the next facility, the engine
   dedup guard saw fetch_X as already-completed from the prior epoch
   and short-circuited.
5. **Row preservation across `mark_step_completed` calls** (commit
   `c81e9910`). Replay invokes `mark_step_completed` twice per non-
   task-sequence step: once with the `call.done` event.result (carries
   `context.rows` inlined by `_build_reference_only_result` for small
   result sets) and once with the `step.exit` event.result (scalars
   only — rows stripped). The second call overwrote step_results with
   a row-less snapshot. Downstream templates like
   `{{ load_next_facility.context.rows[0].facility_mapping_id | int }}`
   silently rendered to undefined → cursor claim SQL matched zero
   rows and all workers drained with 0 processed. Fix merges rows
   forward from the prior step_result when the incoming one lacks
   them.

## What the `loop.cursor` DSL looks like

```yaml
- step: fetch_assessments
  loop:
    cursor:
      kind: postgres
      auth: pg_k8s
      claim: |
        WITH reclaim_stale AS (
          UPDATE public.pft_test_patient_work_queue
          SET status = 'pending', claimed_at = NULL, worker_id = NULL,
              updated_at = NOW()
          WHERE execution_id = '{{ execution_id }}'
            AND data_type = 'assessments'
            AND status = 'claimed'
            AND claimed_at < NOW() - INTERVAL '5 minutes'
        ),
        candidate AS (
          SELECT patient_id, facility_mapping_id
          FROM public.pft_test_patient_work_queue
          WHERE execution_id = '{{ execution_id }}'
            AND facility_mapping_id = (
              {{ load_next_facility.context.rows[0].facility_mapping_id | int }}
            )
            AND data_type = 'assessments'
            AND status = 'pending'
          ORDER BY patient_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE public.pft_test_patient_work_queue q
        SET status = 'claimed',
            attempt_count = q.attempt_count + 1,
            worker_id = 'cursor:assessments',
            claimed_at = NOW(),
            updated_at = NOW()
        FROM candidate c
        WHERE q.execution_id = '{{ execution_id }}'
          AND q.facility_mapping_id = c.facility_mapping_id
          AND q.data_type = 'assessments'
          AND q.patient_id = c.patient_id
        RETURNING q.patient_id, q.facility_mapping_id;
    iterator: patient
    spec:
      mode: cursor
      max_in_flight: 100
  tool:
    - name: init_page
      kind: noop
      spec: { policy: { rules: [{ else: { then: { do: continue, set: { iter.page: 1 }}}}]}}
    - name: fetch_page
      kind: http
      url: '{{ api_url }}/api/v1/patient/assessments'
      params: { patientId: '{{ iter.patient.patient_id }}', page: '{{ iter.page }}' }
      # retry/continue policy…
    - name: save_page
      kind: postgres
      auth: pg_k8s
      command: |
        INSERT INTO ... VALUES (
          {{ iter.patient.patient_id }},
          {{ iter.patient.facility_mapping_id | int }},
          …
        )
        ON CONFLICT … DO UPDATE SET …;
    - name: paginate
      kind: noop
      spec: { policy: { rules: [{ when: '{{ iter.has_more == "true" }}', then: { do: jump, to: fetch_page, set: { iter.page: '{{ iter.page | int + 1 }}' }}}]}}
  next:
    arcs:
      - step: mark_assessments_done
        when: '{{ event.name == "loop.done" }}'
```

Per-claim values flow as:

- Engine-side (dispatch time): render the claim template once against
  the full render context (`execution_id`, `load_next_facility`
  results, ctx/workload, etc.). Bake facility-scoped values into the
  SQL so concurrent facility transitions can't race the claim.
- Worker-side (per iteration): `iter.<iterator> = row`; the task
  chain renders the body against that.

## Current status (2026-04-21)

- **Infrastructure complete and validated**. Single-facility PFT
  runs hit 1000/1000 × 5 data types reliably on
  `feat/storage-rw-alignment-phase-1`.
- **Multi-facility fix landed**. The row-preservation fix
  (`c81e9910`) unblocked `ctx.facility_mapping_id` threading. Run
  `610209020581774041` hit facility 1 at 4999/5000 in ~4 minutes
  (previously stuck at 0/5000 because the claim SQL rendered
  `facility_mapping_id = ()`). End-to-end 10-facility validation is
  in progress.
- **Event reduction achieved**. Envelope events aside, a single
  cursor loop epoch produces N call.done + 1 loop.done per epoch
  versus (7 × 1000) real + (~3 × 3 × 1000) envelope events in the
  old model — matching the ~10× target.
- **Still to land** (outside the cursor-loop primitive itself):
  - `noetl.execution.state` isn't being populated by `save_state`
    (UPDATE against an empty row silently no-ops). Every event
    handler reloads via replay instead. That replay is what surfaces
    the row-stripping issue we just fixed; the deeper underlying bug
    is worth investigating separately.
  - The PFT playbook still uses `load_next_facility.context.rows[0]`
    in many places. This works with the row-preservation fix, but a
    cleaner long-term shape is storing the facility id in `ctx` or
    `workload` so templates aren't reaching into query result
    internals.

## Open questions still in scope

Unchanged from the design doc:

- **Per-item idempotency key**: should the engine compute a stable
  hash of the claimed row for dedup on worker resume? Current stance:
  the claim statement returns a `work_id` column the item chain uses.
- **Dynamic concurrency**: ramp `max_in_flight` up/down based on
  throughput? Out of scope for the first version.
- **Cross-driver transactions**: a cursor over postgres with a save
  task writing to MySQL — claim is committed immediately, so the row
  is `claimed` even if the save fails. The driver's stale-claim
  reclaim prelude (5-minute default) is the recovery mechanism.
