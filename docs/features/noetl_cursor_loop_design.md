# Cursor-driven loops — design proposal

*Status: draft — seeking review before implementation*

## Motivation

The current `step.loop` primitive materializes a collection up-front
(`loop.in: '{{ some_query.rows }}'`), stores it in NATS KV, and drives
iteration through engine-side CAS bookkeeping:

- `claim_next_loop_indices` atomically claims `max_in_flight` indices per
  call, using NATS CAS for `scheduled_count` / `completed_count`.
- Each iteration emits a full terminal batch (`command.issued`,
  `command.claimed`, `command.started`, `step.enter`, `call.done`,
  `step.exit`, `command.completed`) plus 3 envelope events (`batch.accepted`
  / `batch.processing` / `batch.completed`).

This has produced several classes of stall in the PFT flow test:

1. **CAS exhaustion** (`max_retries=5` before bump): concurrent `call.done`
   handlers race to increment `scheduled_count`, losers return `[]` and
   dispatch stalls at `scheduled_count < collection_size` with a handful of
   tail items never issued.
2. **Reference-only collections**: when the collection source is
   externalized to TempStore, replay-time re-render fails StrictUndefined
   and `set:` mutations get clobbered with literal `"{{ ... }}"` strings.
3. **Event amplification**: ~13–16 events per iteration (7 real + ~3
   envelope per emission × ~3 emissions per iteration).  A 10 000-item loop
   generates 150 000+ events.
4. **Collection materialization overhead**: the entire collection is
   serialized to a NATS KV blob at loop-start; for 1 000 patient rows that
   is a meaningful write even before any work happens.
5. **Tail-repair must back-fill**: the engine keeps special-case logic
   (`_find_missing_loop_iteration_indices`, `_TASKSEQ_LOOP_REPAIR_THRESHOLD`)
   to re-issue iterations that never completed — a symptom, not a cure.

All five issues are consequences of driving a distributed work queue
through an engine-side counter instead of letting the work queue itself be
the source of truth.

## Proposal

Keep the `step.loop` container.  Add a new **source** alongside the
existing `loop.in` collection source: `loop.cursor`.

A cursor-driven loop is a pull-model worker pool:

- The engine dispatches `N` worker commands (N = `loop.spec.max_in_flight`,
  aka the concurrency knob).
- Each worker command runs a new runtime contract: it executes the
  cursor's `claim` statement against the cursor's `auth` target, processes
  the returned row through the step's task chain, then **loops back** and
  claims the next row.  A worker exits (emits `call.done`) when its claim
  returns zero rows.
- Step-level `loop.done` fires when *all* N workers have exited.  No
  collection, no `scheduled_count`, no tail-repair.

Because the cursor is explicit, the same primitive works for any source
that can atomically return a single row:

```yaml
loop:
  cursor:
    kind: postgres     # plus: mysql, snowflake, clickhouse, redis, nats_stream…
    auth: pg_k8s
    # any SQL that atomically claims one row and returns the columns the
    # iteration body needs.  `UPDATE ... FOR UPDATE SKIP LOCKED RETURNING`
    # is the typical postgres shape.
    claim: |
      WITH candidate AS (
        SELECT patient_id, facility_mapping_id
        FROM public.pft_test_patient_work_queue
        WHERE execution_id = '{{ execution_id }}'
          AND facility_mapping_id = (SELECT facility_mapping_id FROM public.pft_test_facilities WHERE active = TRUE ORDER BY facility_mapping_id LIMIT 1)
          AND data_type = 'assessments'
          AND status = 'pending'
        ORDER BY patient_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.pft_test_patient_work_queue q
      SET status = 'claimed',
          worker_id = %(__worker_slot_id)s,
          claimed_at = NOW(),
          attempt_count = q.attempt_count + 1
      FROM candidate c
      WHERE q.execution_id = '{{ execution_id }}'
        AND q.facility_mapping_id = c.facility_mapping_id
        AND q.data_type = 'assessments'
        AND q.patient_id = c.patient_id
      RETURNING q.patient_id, q.facility_mapping_id;
    iterator: patient           # exposed as iter.patient.*
  spec:
    mode: cursor                # new mode; exclusive-to-cursor loops only
    max_in_flight: 100          # concurrency: number of worker slots
tool:
  # existing task-sequence chain — unchanged contract
  - name: fetch
    kind: http
    url: '{{ api_url }}/api/v1/patient/assessments'
    params:
      patientId: '{{ iter.patient.patient_id }}'
    ...
  - name: save
    kind: postgres
    command: |
      INSERT INTO public.pft_test_patient_assessments ...
      UPDATE public.pft_test_patient_work_queue SET status='done' ...
next:
  arcs:
    - step: mark_assessments_done
      when: '{{ event.name == "loop.done" }}'
```

### Runtime contract

Engine (per step dispatch):

1. Validate `loop.cursor` spec: `kind`, `auth`, `claim`, `iterator`.
2. Dispatch `max_in_flight` worker commands in parallel, each with a
   unique `__worker_slot_id` (engine-assigned snowflake).
3. Do **not** render the loop collection; do **not** write loop state to
   NATS KV; do **not** use `claim_next_loop_indices`.

Worker (per worker command):

1. Receive the command; open the cursor connection (`auth` → connection
   pool, same lookup as the postgres tool today).
2. Inside a single worker process loop (not engine loop):
   1. Execute `claim` in its own transaction.  Use `autocommit` per
      iteration so the row-claim commits immediately and other workers
      see it.
   2. If the claim returns zero rows → commit, close connection, emit one
      terminal `call.done` with `{status: "ok", processed: <N>}`.  Done.
   3. Otherwise, render the task chain with `iter.<iterator> = row`.
      Execute the chain as today.
   4. Emit a lightweight per-item event (see event model below).
   5. Go to step 2.1.

Engine (collecting results):

- Count worker `call.done` events per step/epoch.  When the count equals
  the dispatched worker count, fire `loop.done`.
- Aggregated result = `sum(processed)` across workers, plus optional
  per-item sampled results if the step requests them (`loop.aggregate`).

### Event model

One `command.*` + one `call.done` per **worker**, not per item.  Per-item
observability comes from a new low-cost event type:

- `cursor.item.done` (informative-only, not actionable) with
  `{worker_slot_id, iteration_index_in_worker, item_key, duration_ms,
  outcome}` — batched through the existing `events.batch` pipe.

For a 1 000-item loop with concurrency 100:

- Old model: ~9 000 real events + ~27 000 envelope events = ~36 000 events.
- New model: ~900 real events (100 workers × 9 events) + 1 000
  informative `cursor.item.done` + ~1 500 envelope = ~3 400 events.
  **~10× reduction**.

### Why drivers and not just SQL?

`kind: postgres` is the first driver; its claim uses
`FOR UPDATE SKIP LOCKED`.  The same primitive needs to work for other
systems whose claim semantics differ:

- **MySQL 8+**: same pattern (`SELECT ... FOR UPDATE SKIP LOCKED` is
  supported).
- **Snowflake / BigQuery / ClickHouse**: no row-level skip-locked; the
  driver needs an advisory-lock or merge-based claim (`MERGE INTO ... WHEN
  NOT MATCHED`).  Driver hides that detail.
- **Redis streams / NATS JetStream consumer**: the claim is
  `XREADGROUP` / `consumer.next()`; the driver maps that to the engine's
  "row or nothing" contract.
- **S3 bucket listing**: `kind: s3_prefix`, claim pulls one object key
  into a "claimed" prefix via copy+delete.

The driver registry lives alongside the existing tool-kind registry
(`noetl/tools/postgres`, `noetl/tools/http`, …).  A driver implements:

```python
class CursorDriver(Protocol):
    def open(self, auth: Credential, spec: dict) -> CursorHandle: ...
    def claim(self, handle: CursorHandle, ctx: dict) -> Optional[dict]: ...
    def close(self, handle: CursorHandle) -> None: ...
```

No engine change per new driver — just a registry entry.

### Resilience

- **Worker crash mid-item**: the claim SQL sets `status='claimed'` and
  `claimed_at=NOW()`.  A separate `reclaim` hook (optional on the cursor
  spec, default provided for postgres) resets claims older than
  `reclaim_after` back to `pending`.  One reclaim job per execution runs
  on a timer in the engine — or, simpler, the `claim` CTE itself reclaims
  stale rows as part of its own prelude.  The PFT playbook already has
  this shape in `load_patients_for_X`.

- **Poison rows**: `attempt_count` is incremented on every claim.  The
  claim statement can `WHERE attempt_count < max_attempts`; failures past
  that threshold flip to `dead_letter` and the worker skips them.

- **Graceful shutdown**: workers check `execution_state == 'cancelling'`
  between iterations and exit cleanly.

### Migration path for the PFT playbook

The PFT flow's five `fetch_X` steps + five `load_patients_for_X` steps +
five `mark_X_done` steps collapse to **five** cursor-loop steps.
`wait_for_all_barriers` becomes unnecessary because each `fetch_X`'s
`loop.done` fires only when the work queue is fully drained (the claim
returns zero).

Before:

```
claim_patients_for_X (500-row claim)
  ↓
fetch_X (task_sequence, max_in_flight=100)
  ↓ loop.done
load_patients_for_X (checks remaining_count via reclaim + count)
  ↓ arcs: remaining>0 → claim, remaining==0 → mark
mark_X_done (CTE: data_check + reclaim + barrier_insert)
  ↓ arc: always → wait_for_all_barriers
wait_for_all_barriers (polls barrier count, self-loops)
  ↓ arc: barrier_count>=5 → prepare_mds_work
```

After:

```
fetch_X (kind: loop with cursor, concurrency=100)
  ↓ loop.done
mark_X_done (CTE: data_check + barrier_insert, no reclaim needed)
  ↓ arc: always → wait_for_all_barriers
wait_for_all_barriers (unchanged)
  ↓ arc: barrier_count>=5 → prepare_mds_work
```

Four steps removed per data type × 5 data types = 20 steps removed from
the playbook.  The remaining reclaim concern (worker crash during
processing) is handled by the driver-provided reclaim prelude inside the
cursor's claim SQL itself.

## Implementation plan (multi-PR)

1. **Pydantic models**: add `CursorLoopSpec`, extend `LoopSpec` to accept
   a `cursor` instead of `in_`.  Reject playbooks mixing both.
2. **Driver registry**: `noetl.core.cursor_drivers` with
   `postgres.PostgresCursorDriver` as the first implementation.
3. **Engine dispatch**: `_issue_loop_commands` detects `loop.cursor`,
   dispatches `max_in_flight` worker commands with a new control arg
   `__cursor_worker: True`.
4. **Worker runtime**: new path in `nats_worker` that handles
   `__cursor_worker` commands — opens driver handle, runs the
   claim-process-release loop, emits one terminal `call.done` at
   exhaustion.
5. **Aggregation**: `loop.done` trigger condition changes for cursor
   loops: fires when `worker_call_done_count == dispatched_workers` per
   epoch.
6. **PFT migration**: rewrite `test_pft_flow.yaml` to use cursor loops;
   delete the `load_patients_for_X` / `claim_patients_for_X` /
   `wait_for_all_barriers` steps.
7. **Docs**: user-facing guide + this design note under
   `docs/features/noetl_cursor_loop_design.md`.

Backwards compatibility: `loop.in` continues to work unchanged.  Cursor
is opt-in per step via `loop.cursor`.

## Open questions

- **Per-item idempotency key**: should the engine compute a stable hash
  of the claimed row so that a crashed worker's partial writes can be
  deduped on resume?  Tentatively: the claim statement itself should
  return a `job_id` / `work_id` column that the item chain uses as an
  idempotency key.  Not an engine concern.
- **Dynamic concurrency**: allow `max_in_flight` to ramp up/down based
  on throughput?  Out of scope for the first version.
- **Cross-driver transactions**: a cursor over postgres with a save task
  that writes to mysql — is the claim-process-release atomic enough?
  The claim commits immediately, so the row is marked `claimed` even if
  the save fails.  Reclaim (via stale-claim timeout in the claim prelude)
  is the recovery mechanism.  Document this clearly.
