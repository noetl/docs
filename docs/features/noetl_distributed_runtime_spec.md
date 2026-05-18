---
title: NoETL Distributed Runtime + Event-Sourced Shared Memory Spec
description: Event-sourced system state, worker-side loop batching, Arrow IPC shared-memory data plane, decentralized projection, and cloud-agnostic event / payload / projection store abstractions for the NoETL distributed runtime.
sidebar_position: 30
---

# NoETL Distributed Runtime + Event-Sourced Shared Memory Spec

Status: staged implementation in progress.
Owner: NoETL core (`repos/noetl`).
Implementation tracker:

- Umbrella: `noetl/noetl#434`.
- Phase 0 PR: `noetl/noetl#435`.
- Phase 1 frame execution: `noetl/noetl#436`.
- Projectors: `noetl/noetl#437`.
- Shared payload cache / Arrow IPC hints: `noetl/noetl#438`.
- Event/projection store ports: `noetl/noetl#439`.
- Replay regression / serialization gates: `noetl/noetl#440`.
- Docs alignment: `noetl/noetl#441`.
Companion specs that this revision builds on (do not re-spec):

- `noetl_async_sharded_architecture.md` — sharded projection workers, epoch barriers.
- `noetl_cursor_loop_design.md` — cursor-driven worker loops (already in production for PFT v2).
- `noetl_data_plane_architecture.md` — control/data plane split, reference-only event envelopes, TempStore tiers.
- `noetl_distributed_processing_plan.md` — phased rollout: P0 shipped, P1–P3 partial.
- `noetl_pft_performance_optimization.md` — PFT-specific tuning.
- `distributed_fanout_mode_spec.md` — designed but not shipped; this spec absorbs it.
- `nats_kv_distributed_cache.md` — NATS K/V scope.

Not in scope here: DSL surface changes or the playbook authoring guide. Event-sourcing invariants are in scope because they are the contract that lets the distributed runtime reproduce system state at a requested point in time.

Latest implementation checkpoint:

- Local kind full PFT v2 execution `629193644754337792` completed on 2026-05-18 in **487.855s (~8m08s)** using `frame.process: frame`, per-stage frame-stream lock ordering, and the full frame lifecycle (`frame.dispatched -> frame.started -> frame.committed`).
- The previous local kind default-row-frame baseline was **1880.739s (~31m21s)**; the row-concurrency experiment was **2002.841s (~33m23s)**.
- The full lock-order validation produced **5,496 committed frames**, **49.94 average rows/frame**, **50 max rows/frame**, and **5,496/5,496 frames with claim, start, and terminal event links**.
- Validation passed for all 10 facilities: all patient domains were **1000/1000** and MDS was **224,443/224,443**.
- The canonical PFT v2 fixture shape remains preserved for regression coverage. Page-continuation fidelity is covered by a companion fixture, `fixtures/playbooks/pft_flow_test/test_pft_page_continuation.yaml`, which follows `paging.hasMore` with one HTTP request per patient/data-type/page record instead of changing the canonical benchmark.
- 2026-05-18 hardening update: `noetl/noetl#453` removes the remaining lazy frame-mint advisory lock from the cursor claim hot path by using an indexed stage/worker-slot/frame-index claim key with `INSERT ... ON CONFLICT DO NOTHING`; `noetl/noetl#454` fixes execution-list status flicker when a late non-terminal projection event follows an already-terminal `noetl.execution.status`.
- 2026-05-18 serialization gate update: `noetl/noetl#456` rejects frame commit `output_ref` envelopes that advertise an IPC/shared-memory hint without any durable `ref`, `uri`, or `locator`, preserving replay authority after cache GC.

---

## 1. Why this revision exists

The PFT v2 workload (`fixtures/playbooks/pft_flow_test/test_pft_flow_v2.yaml`) is the canonical stress test for the distributed runtime. It exercises:

- 10 facilities × 1000 patients × (assessments × 4 pages + conditions × 3 + medications × 3 + vital signs + demographics + MDS detail fan-out) ≈ **120k HTTP requests + ~26k claim cycles per execution**.
- A successful 2026-05-15 local-kind run completed in **3h 54m 21s**, wrote **26,199 commands** to `noetl.event` with `event_type='command.*'`, and required two automatic recoveries by the in-process command reaper.

Even after the cursor-loop refactor (`noetl_cursor_loop_design.md`) eliminated per-iteration collection materialization, three structural costs remain:

| Cost | Where it shows up | Order of magnitude in PFT v2 |
|---|---|---|
| Server-side per-claim coordination | `claim_next_loop_indices` and `_issue_cursor_loop_commands` in `repos/noetl/noetl/core/dsl/engine/executor/` | one HTTP claim round-trip per cursor row |
| Per-fragment event amplification | each worker claim emits `command.issued / claimed / started / call.done / step.exit / command.completed` | 6× events × ~26k fragments ≈ 150k event rows |
| Server-centric projection | only the server folds events into projection state | single writer to projection store; saturates Postgres pool under MDS bursts |

The 2026-05-15 GKE amber run (`memory/archive/2026/05/20260515-193100-gke-runtime-reaper-pft-v2-amber.md`) saw both the NoETL API DB pool and NATS get into pressure during facility-1 MDS, confirming the central path is the bottleneck.

This spec proposes the next reduction step, but with one correction to the mental model: **the event log is not an implementation detail or a backend adapter concern. It is the temporal kernel of the NoETL business operating system.** Frames, Arrow IPC, distributed caches, local indexes, streaming materialized views, analytical projections, and object storage are accelerators around that kernel. They must never become the only source of state.

That means every durable state transition must be representable as an append-only event with a deterministic serialization contract. Projections, caches, materialized views, local shared memory regions, analytical tables, streaming state, and distributed indexes are all rebuildable derived state. Given an execution id, tenant id, and timestamp or event position, NoETL must be able to replay the canonical event stream and reconstruct the system's command state, frame state, loop progress, projection outputs, and payload references as they existed then.

The implementation priorities are:

1. **Event-sourced state reproduction.** `noetl.event` remains the canonical append-only ledger. Every frame, lease, cursor, payload reference, projection checkpoint, and tenant-visible business state transition is replayable from event data plus immutable payload objects.
2. **Shared memory as a core advantage.** The runtime uses a tiered shared-state fabric: in-process memory, node-local Arrow IPC, local disk/NVMe, NATS K/V for small distributed coordination state, and durable object storage. This fabric makes colocated execution fast without weakening replay.
3. **Worker-side batched loop execution.** Workers claim and execute *frames* (multi-row windows) instead of single cursor rows. Per-fragment events drop by a factor equal to the frame size.
4. **Decentralized projection.** Projection workers become pluggable, sharded, and horizontally scalable, with NATS consumer groups for fan-out and a stable identity scheme so they can re-attach to their shard after restart.
5. **Cloud-agnostic event / payload / projection store abstractions.** Port/adapter architecture for NATS JetStream / Kafka / Pub/Sub / Event Hubs / Kinesis; for S3 / GCS / Azure Blob / SeaweedFS; and for operational, analytical, search, vector, and streaming projection backends.

The end state is a **distributed business operating system** in the NoETL sense: every tenant, organization, execution, compute actor, queue, stream, cache object, projection, and payload is addressable via a unified resource locator; workers scale on real backlog signals; loops collapse to map-reduce style stages whose data plane uses shared memory whenever colocated and durable storage otherwise; and auditors/operators can reproduce the state of the organization at a given event position.

---

## 2. Non-goals

- This is not a rewrite of the NoETL DSL. Existing `next.arcs[]`, `set:`, `mode:` semantics stay.
- This does not replace Postgres as the default projection store. Postgres remains the reference; new backends are opt-in.
- This is not a new Arrow distribution mechanism. We use `pyarrow` and `arrow-rs` as-is.
- This is not a green-field event sourcing platform. We keep `noetl.event` as the canonical source of truth; new layers wrap, distribute, cache, mirror, and project it, but they do not replace it.

---

## 3. Architecture overview

```
            ┌─────────────────────────────────────────────┐
            │                Server (planner)             │
            │  - schedules stages, not iterations         │
            │  - mints frame leases on each loop          │
            │  - exposes claim/heartbeat/commit endpoints │
            └────────────┬──────────────────┬─────────────┘
                         │ control events    │ frame leases
                         ▼                   ▼
       ┌─────────────────────────┐  ┌──────────────────────────┐
       │  Event Store (Tier A)   │  │  Projection Store (B)    │
       │  NATS JS / Kafka /      │  │  Postgres / DynamoDB /   │
       │  Pub/Sub / Event Hubs / │  │  Firestore / Cassandra / │
       │  Kinesis                │  │  analytical / search /   │
       │                         │  │  operational backends    │
       │  (append-only ledger +  │  │  (derived, replayable    │
       │   stream adapters)      │  │   state)                 │
       └──────────┬──────────────┘  └────────────┬─────────────┘
                  │ subscribe                     │ project
                  ▼                               ▼
            ┌─────────────────────────────────────────────┐
            │              Workers (runners)              │
            │  - claim a frame (N rows / N seconds /      │
            │    bounded memory)                          │
            │  - run inner DSL block in-process           │
            │  - accumulate results in Arrow RecordBatch  │
            │  - flush to IPC + Tier 3 + emit one event   │
            │  - heartbeat lease; on crash, frame is      │
            │    handed off via cursor checkpoint         │
            └────────────┬──────────────────┬─────────────┘
                         │                  │
                         ▼                  ▼
       ┌─────────────────────────┐  ┌──────────────────────────┐
       │  Tier 1.5 — Arrow IPC   │  │  Tier 3 — Payload Store  │
       │  shared memory          │  │  S3 / GCS / Azure Blob / │
       │  (same host only)       │  │  SeaweedFS (durable,     │
       │                         │  │  content-addressed)      │
       └─────────────────────────┘  └──────────────────────────┘
```

Three core moves vs today:

- **Event stream as the kernel.** Append-only events plus immutable payload objects are the durable operating-system journal. Everything else is an index, cache, materialized view, or delivery stream derived from that journal.
- **Stage-shaped scheduling.** The server no longer thinks in cursor rows; it thinks in *frames*. A frame is a unit of work a worker can execute end-to-end, of bounded duration and bounded result size, and is independently recoverable.
- **Worker as the loop interpreter.** The inner DSL block of a loop step is interpreted inside the worker that owns the frame, not via N round-trips to the server.
- **Data plane separate from control plane.** Frame outputs flow as Arrow record batches over shared memory when possible and as content-addressed objects in Tier 3 always. The event store only ever carries lightweight manifests.

### 3.1 Event-sourced state contract

NoETL has one canonical state rule:

> If it must be reproduced, audited, routed, billed, retried, or explained later, it must be represented by an event and any referenced immutable payload objects.

The event stream is the durable timeline for a multitenant organization. Projections are allowed to be fast, denormalized, and backend-specific, but they must be disposable. A projection rebuild from `(tenant_id, organization_id, execution_id, from_position, to_position)` must produce the same state as the original run, modulo explicitly declared non-deterministic external side effects.

Required event envelope fields:

```json
{
  "event_id": "snowflake-or-ulid",
  "tenant_id": "tenant-123",
  "organization_id": "org-456",
  "execution_id": "987654321",
  "stream_id": "execution/987654321/stage/fetch_patients",
  "aggregate_id": "frame/123",
  "aggregate_type": "frame",
  "event_type": "frame.committed",
  "schema_name": "noetl.frame.committed",
  "schema_version": 1,
  "event_time": "2026-05-16T12:34:56.789Z",
  "ingest_time": "2026-05-16T12:34:56.812Z",
  "producer": "noetl://tenant/tenant-123/org/org-456/cluster/prod-1/.../worker/cpu-01",
  "causation_id": "event-that-caused-this-event",
  "correlation_id": "execution-or-business-flow-id",
  "idempotency_key": "tenant/org/execution/frame/event-kind/attempt",
  "payload_ref": {
    "uri": "noetl://tenant/tenant-123/org/org-456/payloads/sha256/...",
    "sha256": "...",
    "media_type": "application/vnd.apache.arrow.stream"
  },
  "meta": {}
}
```

Envelope invariants:

- `tenant_id` and `organization_id` are mandatory on every event and payload reference. They are the isolation boundary for routing, replay, retention, encryption, and billing.
- `event_id` is globally unique and monotonic enough for local ordering, but replay correctness depends on `(stream_id, stream_version)` or backend position, not wall-clock time.
- `expected_version` is enforced per aggregate/stream where the backend supports it. Where the transport cannot enforce it directly, a side index records stream versions.
- `idempotency_key` is mandatory for externally retried transitions. Duplicate delivery may occur; duplicate durable effects must not.
- `payload_ref` points to immutable content. Events never point to mutable cache paths as their only copy.

### 3.2 Time-travel and replay

The replay API is a first-class implementation target, not a diagnostic afterthought:

```text
GET /api/replay/state
  query:
    tenant_id
    organization_id
    execution_id
    as_of_event_id | as_of_position | as_of_time
    projection = execution | frame | loop | business_object | all
```

Implementation status:

- `GET /api/replay/state` shipped in Phase 0 (`noetl/noetl#435`).
- Phase 0 folds execution, frame, stage, loop, and payload-reference lineage from `noetl.event`.
- The endpoint returns a deterministic `sha256` checksum over the folded state.
- The live reader tolerates pre-migration event tables during rolling rollout. If the additive tenant/org envelope columns are not present yet, replay treats only `tenant_id=default` and `organization_id=default` as visible legacy events.
- A core replay upcaster registry now exists in Phase 0 (`noetl.core.replay.EventUpcasterRegistry`) and is wired into `ReplayService.replay_state`. The default registry preserves legacy events as `schema_name=noetl.event`, `schema_version=1`.
- Replay state includes `upcaster_registry_digest`, a stable SHA-256 digest of the registered `(schema_name, from_version)` transitions used for the fold.
- A golden replay corpus now lives under `tests/fixtures/replay/` in `repos/noetl` and asserts a stable fold checksum for execution, stage, frame, payload-reference, and registry-digest state.
- Event-position snapshot selection now exists for `projection_snapshot` rows with `aggregate_type=replay_state` and `aggregate_id=execution/<execution_id>/<projection>`. Replay can seed from the snapshot, skip earlier events, and fold the remaining stream.
- Time-based snapshot selection, payload resolution, registered production upcasters for future schema revisions, and business-object projection folds remain tracked by `noetl/noetl#440`.

Replay reconstructs state by:

1. Loading the latest validated snapshot at or before the requested position.
2. Reading canonical events from that snapshot position through the requested cutoff.
3. Resolving immutable payload references through the payload store.
4. Applying schema upcasters in deterministic order. The Phase 0 registry enforces monotonic version advancement so an upcaster cannot silently rewrite an event without moving the schema version forward.
5. Folding events with the same projection code used by live projectors.

Snapshots are performance accelerators. They are never the authority. A snapshot must record:

- event position covered;
- projection code version;
- schema upcaster versions and registry digest, matching the replay state's `upcaster_registry_digest`;
- payload digest set or Merkle root;
- tenant encryption context;
- deterministic fold checksum.

Replay verification becomes a release gate for every phase after Phase 0: run live execution, rebuild projections from events, and compare checksums for execution state, frame state, loop progress, and configured business projections.

The first golden checksum gate is intentionally small. It does not replace live PFT replay parity; it gives every future serializer/upcaster/projection change a cheap deterministic test that fails before a full cluster run.

### 3.3 Visual component diagram

The diagram below maps all named components to their roles, storage tiers, and primary data flows. Solid arrows are runtime data paths; dashed arrows are control or fallback paths.

```mermaid
graph TD
    subgraph TENANT["Tenant / Organization Boundary"]

        subgraph CP["Control Plane"]
            SRV["Server / Planner\nStage scheduling · Frame lease minting\nClaim / Heartbeat / Commit endpoints\nFrame reaper"]
        end

        subgraph KERNEL["Event Kernel — Append-Only Temporal Authority"]
            PG[("Canonical Log\nPostgres noetl.event\npartitioned by tenant / time / execution")]
            DIST[("Distribution Stream\nNATS JetStream · Kafka · Pub/Sub\nEvent Hubs · Kinesis\nfan-out transport — not canonical authority")]
        end

        subgraph OBJSTORE["Immutable Payload Store — Port/Adapter"]
            PAY[("Content-Addressed Objects\nS3 · GCS · Azure Blob · SeaweedFS\nsha256-keyed · immutable on write\nstreaming upload / download")]
        end

        subgraph FABRIC["Shared-State Fabric — Rebuildable from Events"]
            T1["Tier 1\nIn-process LRU\nper process"]
            T15["Tier 1.5\nApache Arrow IPC shm / memfd\nsame-node zero-copy"]
            T2["Tier 2\nNVMe disk cache\nper node"]
            NKV["NATS K/V\nLeases · counters · coordination"]
        end

        subgraph EXEC["Execution Layer — StatefulSet"]
            W["Worker / Frame Executor\nClaims N-row frames from stage\nRuns inner DSL block in-process\nArrow RecordBatch to Tier 1.5 + Tier 3\n1 canonical event per frame committed"]
            PROJ["Projector — N shards\nDurable NATS pull consumer per shard\nPayloadRef resolved via cache hierarchy\nHorizontally scalable · shard-stable across restarts"]
        end

        subgraph PSTORES["Projection Stores — Derived · Replayable — Port/Adapter"]
            OP[("Operational\nPostgres\nExecution status · API reads")]
            AN[("Columnar Analytical\nEvent lake · billing facts · org audit timeline")]
            MV[("Streaming MV\nBarrier-aligned incremental aggregations\nWork-queue derived state")]
            SV[("Search / Vector\nRetrieval shapes only\nRebuilt from event / payload source")]
        end

        PG -->|mirror| DIST
        SRV -->|stage.opened · frame lease events| PG
        SRV -->|frame claim dispatch| W
        DIST -->|durable pull consumer| W
        DIST -->|durable pull consumer| PROJ

        W -->|Tier 3 — always durable| PAY
        W -->|Tier 1.5 — best-effort fast path| T15
        W -->|1 canonical event per frame| PG

        T1 -. miss .-> T15
        T15 -. miss .-> T2
        T2 -. miss .-> PAY

        PROJ -->|resolve PayloadRef| T1
        PROJ -->|write| OP
        PROJ -->|write| AN
        PROJ -->|write| MV
        PROJ -->|write| SV

        SRV -. Replay API as_of_position .-> PG
        SRV -. Replay API resolve payload refs .-> PAY

    end
```

Key observations from the diagram:

- **Event Kernel is the single append authority.** The canonical log is the only target for durable writes. The distribution stream mirrors it for low-latency fan-out but carries no replay authority.
- **Payload Store and Canonical Log are the correctness pair.** Losing either breaks replay. Every other tier and store can be dropped and rebuilt from these two.
- **Shared-state fabric follows a strict miss chain.** Tier 1 → 1.5 → 2 → Tier 3 (Payload Store). Writers always write Tier 3 first; higher tiers are best-effort and admission-controlled.
- **Projectors are the sole writers to projection stores.** After Phase 2, the server never writes projection state directly.
- **Port/Adapter boundaries** (labeled on subgraphs) mark where backend substitutions happen at deploy time; the runtime image does not change.

---

## 4. Workload baseline (instrument before refactor)

Before any code change ships, baseline the PFT v2 run with telemetry the team can reason from. This is the metric set every later phase is judged against.

The PFT fixture API must not become the benchmark bottleneck. The
`paginated-api` test server enforces the PFT endpoint request limit in each
process, so local kind and GKE deployments should run at least three replicas
for PFT v2 validation. That gives enough pod-level capacity for the target
30-50 requests/second workload while preserving the fixture's per-process
50 requests/second contract and keeping 429s meaningful when a single worker
bursts too hard.

The playbook's `pft_http_concurrency` variable documents the client-side
pressure target. Until `loop.spec.max_in_flight` supports templated values at
catalog validation time, every PFT v2 cursor loop must use the same resolved
integer value rather than drifting to a higher hard-coded concurrency.
Each PFT v2 cursor loop must also opt into `loop.spec.frame` with
`max_rows: 50` so the stage/frame runtime is exercised. A run that leaves
`noetl.stage` and `noetl.frame` empty is still on the legacy cursor-command
path and is not a valid Phase 1 benchmark.

Per execution, capture:

| Metric | How | Today's value (PFT v2 GKE 2026-05-15) |
|---|---|---|
| total `command.*` event count | `SELECT count(*) FROM noetl.event WHERE execution_id = $1 AND event_type LIKE 'command.%'` | ≈ 26k × 6 ≈ 150k |
| frame count | sum of cursor claims that returned > 0 rows | 5,498 in local kind frame-mode run `629145120213828019`; older row-shaped baselines were ~5.5k committed frames but still ran one task pipeline per claimed row |
| mean rows per frame | total rows / frame count | 49.92 in frame-mode run `629145120213828019` |
| server CPU on `/claim` hot path | request-log percentiles from gateway | dominated by GKE pool pressure |
| Postgres pool depth high-watermark | `pg_stat_activity` poll | hit 50 waiters |
| NATS reschedule events | `kubectl get events -n nats` | 1 during facility-1 MDS |
| payload bytes written to Tier 3 | TempStore counter | not currently instrumented |
| projection store write rate | counter on `mark_step_completed` | single writer |
| execution wall time | `noetl.execution.end_time - start_time` | 279.785s local kind frame-mode run; earlier local kind default-row-frame baseline was 1880.739s |

Target after Phases 1–3:

| Metric | Target | Mechanism |
|---|---|---|
| total `command.*` event count | **÷10** | frame-shaped claims, mean rows/frame ≥ 50 |
| server `/claim` requests per execution | **÷50** | one claim per frame |
| Postgres pool depth high-watermark | < 20 sustained | claim path narrower + projection sharded |
| Tier 3 bytes written | unchanged | data goes to Tier 3 either way |
| Tier 1.5 cache hit ratio | > 60% on colocated consumers | new metric, see Phase 3 |
| execution wall time | **÷2** | parallelism + reduced coordination |

A separate dashboard tile per metric is mandatory before merging any phase that claims an improvement.

---

## 5. Control plane: stage and frame model

### 5.1 New tables (additive, no breaking change)

```sql
-- Stage describes a unit of orchestration the planner cares about.
-- One stage per loop step or per fan-out step. Tool steps keep using
-- the existing noetl.command path.
CREATE TABLE IF NOT EXISTS noetl.stage (
  stage_id        BIGINT      PRIMARY KEY,         -- snowflake id
  execution_id    BIGINT      NOT NULL REFERENCES noetl.execution(execution_id),
  parent_event_id BIGINT      REFERENCES noetl.event(event_id),
  parent_stage_id BIGINT      REFERENCES noetl.stage(stage_id),
  loop_event_id   TEXT,
  opened_event_id BIGINT,
  closed_event_id BIGINT,
  kind            TEXT        NOT NULL CHECK (kind IN ('loop','fanout','reduce')),
  step_name       TEXT        NOT NULL,
  dsl_ref         TEXT        NOT NULL,            -- pointer to playbook step
  status          TEXT        NOT NULL DEFAULT 'OPEN',
  frame_policy    JSONB       NOT NULL,            -- size, time, memory bounds
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- Frame is a worker-claimable window of work inside a stage.
CREATE TABLE IF NOT EXISTS noetl.frame (
  frame_id        BIGINT      PRIMARY KEY,         -- snowflake id
  stage_id        BIGINT      NOT NULL REFERENCES noetl.stage(stage_id),
  execution_id    BIGINT      NOT NULL REFERENCES noetl.execution(execution_id),
  parent_frame_id BIGINT      REFERENCES noetl.frame(frame_id),
  command_id      BIGINT,
  claimed_event_id BIGINT,
  terminal_event_id BIGINT,
  cursor          JSONB       NOT NULL,            -- driver-specific resume hint
  row_count       INTEGER     NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'PENDING',
  owner_worker    TEXT,
  lease_until     TIMESTAMPTZ,
  output_ref      JSONB,                           -- {tier3_sha, ipc_handle?}
  events_emitted  INTEGER     NOT NULL DEFAULT 0,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS frame_open_idx
  ON noetl.frame (stage_id, status, lease_until)
  WHERE status IN ('PENDING','CLAIMED','RUNNING');

CREATE INDEX IF NOT EXISTS idx_stage_execution_step_loop
  ON noetl.stage (execution_id, step_name, loop_event_id)
  WHERE loop_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_frame_stage_frame
  ON noetl.frame (stage_id, frame_id);
CREATE INDEX IF NOT EXISTS idx_frame_command
  ON noetl.frame (command_id)
  WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_command_stage_worker_slot
  ON noetl.command (execution_id, stage_id, ((meta->>'worker_slot_id')))
  WHERE stage_id IS NOT NULL AND meta ? 'worker_slot_id';
CREATE INDEX IF NOT EXISTS idx_event_exec_stage_event_id_desc
  ON noetl.event (execution_id, stage_id, event_id DESC)
  WHERE stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_exec_frame_event_id_desc
  ON noetl.event (execution_id, frame_id, event_id DESC)
  WHERE frame_id IS NOT NULL;
```

These coexist with `noetl.event` and `noetl.command`. Legacy tool steps are not migrated.

### 5.1.1 Replay lineage graph

The stage/frame tables are operational projections, but their keys must make replay and audit cheap without scraping JSON. The current implementation uses this graph:

```text
execution
  └─ stage
       ├─ parent_stage_id       -> parent stage for nested/fan-out chains
       ├─ loop_event_id         -> loop epoch that opened the stage
       ├─ opened_event_id       -> noetl.event(stage.opened)
       ├─ closed_event_id       -> noetl.event(stage.closed)
       ├─ command.stage_id      -> worker commands issued for the stage
       └─ frame
            ├─ parent_frame_id  -> upstream frame for derived/reduce work
            ├─ command_id       -> noetl.command that owns the worker slot
            ├─ claimed_event_id -> noetl.event(frame.dispatched)
            └─ terminal_event_id-> noetl.event(frame.committed|frame.failed)
```

`noetl.event` also carries direct `stage_id` and `frame_id` columns for stage/frame lifecycle events and command events where the producer knows the projection key. Those columns are indexed for replay scans by `(execution_id, stage_id, event_id DESC)` and `(execution_id, frame_id, event_id DESC)`. `noetl.command` carries `stage_id` and `frame_id`; the cursor-worker path resolves `frame.command_id` from the command context and has a server-side fallback indexed by `(execution_id, stage_id, meta->>'worker_slot_id')`.

`parent_stage_id` and `parent_frame_id` are the explicit traversal edges for runtime projections. Cursor loops currently use `loop_event_id` as the direct stage correlation key and mint one root frame per stage; subsequent frames in that stage carry `parent_frame_id` to form a deterministic stage-local chain. Fan-out/reduce will extend the same parent ids to preserve the execution tree without replaying every event payload.

### 5.2 Frame policy

`frame_policy` is the configurable bound that decides how much work a single frame contains. Phase 0 adds a typed runtime model as `FramePolicy` and accepts it on cursor loops as `loop.spec.frame` (or `loop.spec.frame_policy` internally). Defaults preserve today's one-row cursor behavior until a playbook opts into batching.

```yaml
loop:
  cursor: ...
  spec:
    mode: cursor
    max_in_flight: 100      # worker slots
    frame:
      max_rows: 50          # max rows per frame
      max_seconds: 30       # max wall-time per frame
      max_bytes: 67108864   # max in-flight serialized output bytes
      lease_seconds: 120    # initial lease window
      heartbeat_seconds: 30 # expected heartbeat cadence
      process: frame        # row = run body once per row; frame = run body once per frame
      retry_mode: whole_frame
      max_attempts: 3
```

For PFT v2, the validated opt-in frame is `{ max_rows: 50, max_seconds: 30, max_bytes: 64MB, lease_seconds: 120, heartbeat_seconds: 30, process: frame }`. `process: row` remains the default for backwards-compatible semantics: the worker claims a frame but runs the declared task pipeline once per row. `process: frame` exposes `frame.rows`, `frame.row_count`, `frame.index`, and `iter.<iterator>_rows` to the task pipeline and runs it once per claimed frame. That is the mode that produced the 2026-05-18 full PFT v2 local kind validations in ~4m30s to ~5m40s.

`row_concurrency` remains available as an opt-in tuning knob for `process: row`, but the 2026-05-17 local kind validation showed `row_concurrency: 4` regressed the full PFT v2 run from ~31m21s to ~33m23s. Leave it at the default `1` unless a workload explicitly needs concurrent row execution inside one frame.

`retry_mode: whole_frame` is the only supported Phase 1 recovery mode. If a
worker crashes or its lease expires before terminal commit, reclaim emits
`frame.abandoned` and then a new `frame.dispatched` attempt for the same frame
boundary. Row-split retry is intentionally not supported yet: splitting a
failed frame would create a second event-sourcing boundary and requires a
future subframe model. A task failure that reaches terminal commit emits
`frame.failed` with the frame cursor, output reference summary, row count,
`events_emitted`, and recovery policy so an operator can audit the lost-work
unit and decide whether to requeue at the business cursor layer.

Implementation status:

- `FramePolicy` now exists in `noetl.core.dsl.engine.models.workflow`.
- Cursor loop dispatch includes the resolved frame policy in both `cursor_worker` tool config and command metadata.
- The `cursor_worker` runtime passes `__frame_max_rows` and `__frame_policy` into cursor claim rendering, then asks the driver for a frame-sized row window. Drivers without a batched path fall back to repeated single-row claims.
- The Postgres cursor driver now implements `claim_many(...)`. If the playbook claim SQL uses `LIMIT {{ __frame_max_rows | default(1) | int }}`, one database round-trip claims a whole frame instead of one row. PFT v2 uses this form for all patient-domain and MDS-detail cursor queues.
- The `cursor_worker` runtime supports both row-mode and frame-mode execution. Row mode runs the existing task pipeline once per claimed row in-process and returns frame metadata in the terminal command result. Frame mode runs the task pipeline once per claimed frame with `frame.rows` in context, so playbooks can batch HTTP, database writes, and reducer-style work while preserving one replayable frame boundary.
- `frame.row_concurrency` is an opt-in bound for processing rows within one frame concurrently in row mode; the default remains `1` to preserve legacy ordering and side-effect behavior.
- Cursor frame commits now carry profiling metadata under `frame.cursor.metrics`: row outcome counts, row concurrency, total task/render/tool milliseconds, and rollups by task kind/name. This is the release-gate instrumentation for deciding whether the next PFT improvement should target HTTP calls, Postgres saves, serialization, or control-plane commits.
- Claimed frame rows are serialized as Apache Arrow IPC stream bytes through `TempStore.put_ipc_bytes`. The command result carries a durable `rows_ref` with schema digest, row count, media type, and optional Tier 1.5 IPC hint. Default `max_rows=1` preserves existing one-row behavior unless a playbook opts into batching.
- Frame commit validation now treats IPC metadata as a cache-only hint: if `output_ref` contains `ipc`, the same envelope must also contain a durable `ref`, `uri`, or `locator`, including nested `rows_ref` shapes. IPC-only frame events are rejected because they cannot be replayed once shared memory is swept.

### 5.3 Claim / heartbeat / commit API

New endpoints on the NoETL server, additive to the existing `/api/commands/*`:

```text
POST /api/stages/{stage_id}/frames/claim
  body: { worker_id, command_id?, requested_count, lease_seconds, cursor, frame_policy }
  returns: [ { frame_id, cursor, lease_until, dsl_ref, frame_policy } ... ]

POST /api/frames/{frame_id}/heartbeat
  body: { worker_id, lease_seconds, status }
  returns: { lease_until }

POST /api/frames/{frame_id}/commit
  body: { worker_id, cursor, output_ref, row_count, status, events_emitted }
  returns: { ok, next_action }   # may immediately hand the worker the next frame
```

Implementation status:

- The frame control-plane endpoints are now present in `repos/noetl` behind the main API router:
  - `POST /api/stages/{stage_id}/frames/claim`
  - `POST /api/frames/{frame_id}/heartbeat`
  - `POST /api/frames/{frame_id}/commit`
- Phase 1 starts with explicit replayable frame leases. Claim either takes a pending/expired frame or lazily creates a frame row for the requested stage.
- Each lifecycle transition emits a canonical frame event:
  - `frame.dispatched`
  - `frame.started`
  - `frame.heartbeat`
  - `frame.abandoned`
  - `frame.committed`
  - `frame.failed`
- Frame lifecycle events now populate `stream_version` and `envelope_checksum`, so replay can order stage-local frame transitions and detect envelope drift with the same checksum contract as the event-store port. Frame telemetry streams use the Snowflake event id as a sparse monotonic `stream_version`; this removes the former per-frame stream advisory lock and `max(stream_version)+1` scan from heartbeat and commit writes.
- Frame claims now persist `frame.command_id` from the worker command context. If an older worker omits it, the server resolves it from `(execution_id, stage_id, worker_slot_id)` using the indexed command metadata path.
- Lazily minted runtime frames use the cursor claim key `(stage_id, cursor.worker_slot_id, cursor.frame_index)` as their idempotency boundary. The hardening patch in `noetl/noetl#453` replaces the remaining stage-scoped frame-mint advisory lock with a partial unique index and conflict reload, keeping duplicate retries deterministic without serializing frame claimers.
- Cursor workers now send a `RUNNING` heartbeat immediately after a successful frame claim and before frame execution. The heartbeat endpoint records the first `CLAIMED -> RUNNING` transition as `frame.started`; later `RUNNING` lease extensions are recorded as `frame.heartbeat`. This keeps the normal replay sequence clear: `frame.dispatched -> frame.started -> frame.heartbeat* -> frame.committed|frame.failed`.
- When a worker reclaims an expired `CLAIMED` / `RUNNING` frame, the server emits `frame.abandoned` before the new `frame.dispatched` event. Replay therefore sees the recovery chain as append-only history rather than inferring it from a mutable row overwrite.
- Recovery metadata is persisted on `frame.abandoned` and `frame.dispatched`: `retry_mode=whole_frame`, `row_split_retry=false`, `max_attempts`, previous owner, reclaimer, prior lease, and previous attempt count. This is enough to audit whether a frame was retried as a whole unit and whether operator intervention is needed after repeated attempts.
- Duplicate or late terminal commits are rejected with `409 frame_already_terminal` and the existing `terminal_event_id`, so a retrying worker cannot emit a second `frame.committed` / `frame.failed` event for the same frame. Heartbeats against terminal frames receive the same conflict response.
- Worker-side cursor integration uses the existing `cursor_worker` path with frame policy and batched driver claims. The remaining Phase 1 work is validation, telemetry, and removing any residual per-row server coordination from non-PFT cursor shapes.

The HTTP surface is the operational fallback. The primary path uses NATS JetStream pull consumers (see §6) for lower-latency claim and built-in lease semantics.

### 5.4 Server's narrower role

After the refactor:

- For a loop step the server emits **one** `stage.opened` event, mints frames lazily as workers ask, and emits **one** `stage.closed` when all frames commit.
- The server **does not** touch per-row state. Cursors are opaque; the server only records the latest committed cursor per frame.
- The server **does not** issue per-row `command.issued` events. Frame claims are observable via `stage` and `frame` rows plus a single `frame.dispatched` event per claim.

The current `command_reaper` repurposes to **frame reaper**: it scans `noetl.frame` for `lease_until < now() AND status IN ('CLAIMED','RUNNING')`, marks the lease abandoned, and republishes the frame. Same correctness guarantees; smaller scan surface.

---

## 6. Data plane: Arrow IPC zero-copy (Tier 1.5)

Tier 1.5 is part of a broader shared-state fabric, not a one-off optimization. The design target is a proven distributed-data pattern: keep durable state in an append-only log and immutable payload objects; keep hot execution state in rebuildable shared caches, indexes, and materialized views.

| Layer | Backends | Purpose | Rebuildable from events? |
|---|---|---|---|
| Canonical log | `noetl.event` Postgres partitions; optional mirrored JetStream/Kafka/Pub/Sub/Event Hubs/Kinesis streams | Durable timeline and replay authority | Source |
| Immutable payloads | S3 / GCS / Azure Blob / SeaweedFS / local durable store | Large event data, Arrow batches, files | Referenced by log |
| Hot shared memory | in-process LRU + Arrow IPC shm/memfd | Same-process and same-node zero-copy reads | Yes |
| Warm node cache | local NVMe/PVC disk cache | Reuse payload blocks after restart or reschedule | Yes |
| Small distributed cache | NATS K/V | Lease hints, loop counters, small coordination state | Yes |
| Streaming materialization | source/table/materialized-view/sink engine with barriers | Incremental state over event streams and work queues | Yes |
| Analytical materialization | columnar analytical projection store | High-volume queryable facts, metrics, audit/event lake views | Yes |

Only the first two layers are required for correctness. The rest are latency, throughput, and serving-shape advantages. This is the core product advantage: NoETL can run like a low-latency distributed shared-memory system while remaining reproducible from an append-only event log.

### 6.1 Where it fits in TempStore

The existing `repos/noetl/noetl/core/storage/result_store.py` already tiers payloads as `MEMORY → KV → DISK → S3/GCS/DB`. We insert a new tier between `MEMORY` and `DISK`:

| Tier | Mechanism | Scope | Lifetime |
|---|---|---|---|
| 1 | in-process LRU (existing) | per process | configurable bytes |
| **1.5** | **Apache Arrow IPC over POSIX shm / memfd** | **per host (all processes on the node)** | **frame lease + 30s grace** |
| 2 | local NVMe disk cache (existing) | per node | configurable GB |
| 3 | S3 / GCS / Azure Blob / SeaweedFS (existing) | global, content-addressed | retention policy |

Tier 1.5 is the zero-copy hop for colocated workers. Tier 3 is always written; Tier 1.5 is best-effort fast path.

### 6.2 Format

Workers materialize loop results as `pyarrow.RecordBatch` (Python) / `arrow_array::RecordBatch` (Rust). The on-disk and on-wire format is **Arrow IPC stream**. The shared memory carrier is one of:

- **POSIX `shm_open`** + `mmap` (Linux/macOS) — simplest, ubiquitous.
- **`memfd_create`** (Linux only) — preferred where available; no path collisions, anonymous file descriptor passed via SCM_RIGHTS over a Unix domain socket from a node-local broker.

For cross-runtime parity (Python ↔ Rust), the SHM region carries:

1. A 16-byte header: magic `NOETLIPC`, format version `u32`, payload length `u64`.
2. The Arrow IPC stream bytes.

This is intentionally simpler than the Plasma object store: NoETL workers are co-tenants of a single Kubernetes pod (one process per container today; if we ever go multi-process per pod we add a small node-local broker — see §6.5). No Plasma client/server fan-out, no shared catalog.

### 6.3 Reference shape

`PayloadReference` (existing in `result_store.py`) gains optional IPC metadata:

```python
@dataclass
class PayloadReference:
    tier3_uri: str           # noetl://tenant/<tenant>/org/<org>/payloads/sha256/<sha256>
    sha256: str
    media_type: str          # "application/vnd.apache.arrow.stream"
    rows: int
    bytes: int

    # Tier 1.5 fast-path hint, may be None or stale
    ipc: Optional[IpcHint] = None

@dataclass
class IpcHint:
    node_id: str             # noetl://tenant/<tenant>/org/<org>/cluster/<id>/node/<id>
    shm_name: str            # /noetl-<execution>-<frame>-<seq>
    schema_digest: str       # quick sanity check before attach
    valid_until: datetime    # writer-promised minimum lifetime
```

Implementation status:

- `repos/noetl` now exposes `IpcHint` on `ResultRef` / `TempRef`.
- `ResultRefMeta` records Arrow/replay-relevant payload metadata: `media_type`, `schema_digest`, and `row_count`.
- `IpcHint` is explicitly best-effort. It carries `shm_name`, `schema_digest`, `byte_length`, optional `row_count`, `producer`, `lease_expires_at`, and media type.
- `ArrowIpcSharedMemoryCache` now provides the first Tier 1.5 implementation surface in `noetl.core.storage.ipc_cache`: budget enforcement, POSIX shared-memory allocation, `IpcHint` creation, read/attach, delete, and expired-lease sweep.
- `TempStore.put_ipc_bytes` / `get_ipc_bytes` now provide an explicit raw Arrow IPC path: durable bytes are always written, IPC admission is optional, and reads fall back to the durable tier when the shared-memory hint is expired or missing.
- `TempStore.ipc_stats()` exposes local counters for admission attempts/success/failures, read attempts/hits/misses, and durable fallback reads.
- `/metrics` now exports the server process's TempStore IPC counters as `noetl_storage_ipc_*` Prometheus metrics, plus `noetl_storage_ipc_read_hit_ratio`. Worker-process metric scraping remains follow-up work unless workers are run with an HTTP metrics sidecar.
- `noetl.core.storage.arrow_ipc` now provides the runtime serialization primitive: `rows_to_arrow_ipc` and `arrow_ipc_to_rows`. Schema digests are computed from Arrow's serialized schema, not from row values, so replay/projector code can compare logical frame shape independently from payload content.
- `cursor_worker` now writes multi-row frame captures through this path when `frame_policy.max_rows > 1` or `NOETL_CURSOR_FRAME_CAPTURE_ENABLED=true`. `NOETL_CURSOR_FRAME_IPC_ENABLED=false` disables only the same-node IPC admission; the durable payload write remains authoritative.
- The durable `ResultRef` remains authoritative; consumers must treat expired or missing IPC hints as cache misses and fall back through durable storage.
- Worker-side metrics export and aggregation across pods remains tracked by `noetl/noetl#438`.

### 6.4 Producer / consumer protocol

Producer (any worker that emits a record batch):

1. Serialize batch to Arrow IPC stream bytes.
2. Write to Tier 3 keyed by `sha256` (idempotent, exists-first check).
3. Attempt Tier 1.5 write: create / open shm, copy buffer (one memcpy from the IPC stream), set `valid_until = now() + lease_until + 30s`.
4. Emit one event whose envelope carries `PayloadReference` with both Tier 3 URI and the optional `IpcHint`.

Consumer (frame commit handler, reducer, projection worker):

1. Read `PayloadReference` from event envelope.
2. Try `IpcHint` if present and `node_id == self.node_id` and `valid_until > now()`: open shm, mmap, wrap as `pyarrow.RecordBatchStreamReader`. Zero-copy.
3. If hint is missing, stale, or another node: read from Tier 1 cache; on miss, Tier 2; on miss, Tier 3.

The consumer **never** trusts the IPC hint blindly. It validates `schema_digest` (cheap), bumps a tier metric, and on any error falls through to the durable read path. The durable read is the source of truth.

### 6.5 Garbage collection and back-pressure

- Each shm region is owned by the producer worker for the duration of its frame lease + 30s grace. After grace, the worker `shm_unlink`s the region.
- Workers track a per-node `tier15_bytes_in_use` counter. New shm writes are admission-controlled by a configurable budget (default 1 GB per node). On budget exhaustion the writer skips Tier 1.5 and emits only the durable Tier 3 reference. No data plane stall.
- For multi-process per pod (future): introduce a `noetl-node-broker` sidecar that owns the shm namespace and brokers lifetimes via Unix-socket RPC. Not required for the current one-process-per-pod deployment shape.

### 6.6 Serialization contract

Serialization is part of the replay contract. If two runtimes read the same event stream and payload objects, they must fold the same state.

Rules:

- **Event envelopes:** canonical JSON for the persisted envelope metadata. Writers must emit stable field names, UTC timestamps, explicit nulls only where schema allows them, and deterministic map key ordering before signing/checksumming.
- **Large tabular payloads:** Apache Arrow IPC stream, media type `application/vnd.apache.arrow.stream`. Every payload records `schema_digest`, `row_count`, `byte_length`, compression codec, and content SHA-256.
- **Nested business payloads:** JSON Schema / OpenAPI-compatible payloads for small objects; Arrow `struct`, `list`, and `map` types for large repeated data. Avoid pickle, language-native binary serialization, or runtime-specific object graphs.
- **Decimals and time:** decimals carry precision/scale; timestamps are UTC with explicit unit; local time zones are data fields, not implicit runtime settings.
- **Schema evolution:** every event has `schema_name` and `schema_version`. Upcasters are pure functions registered by `(schema_name, from_version)` and must advance to a later `schema_version` before the next upcaster can run. The registry is deterministic and covered by replay tests; production releases must also record the registry digest in replay/projection snapshots.
- **Cross-language parity:** Python and Rust compliance tests read the same golden event/payload corpus and compare fold checksums.

The durable payload digest is computed over the exact serialized bytes. The projection checksum is computed over a canonical projection serialization, not over backend-specific storage bytes.

### 6.7 Why Arrow, not raw bytes

- Columnar layout is the right shape for the heavy paths (Postgres bulk reads, DuckDB joins, fanout reducers, projection writes to analytical stores).
- Zero-copy between Python and Rust workers via the C Data Interface comes for free with Arrow. Important once we run a mix of `pyarrow`-using Python workers and `arrow-rs` Rust workers on the same pod.
- The wire schema is self-describing enough for payload reads, while the event envelope still records schema identity/version for governance and replay.

---

## 7. Decentralized projection

### 7.1 Current state

`noetl_async_sharded_architecture.md` already specifies async projection workers and epoch barriers. The projection worker skeleton exists. What is not yet decentralized: the projection still runs **inside the server process**, and the projection write rate caps at the server's single-writer Postgres connection.

### 7.2 Refactor

- Extract projection into its own deployable: `noetl-projector`. Same image, different entrypoint.
- Keep the reducer transport-neutral: the same deterministic projector core must accept events from tests, replay, NATS JetStream, Kafka, or cloud stream adapters. Transport code owns delivery and checkpointing; reducer code owns ordering, folding, lineage, checksum, and idempotent writes.
- Each projector instance owns one or more shards via NATS JetStream pull consumer group (`noetl.projection.shard.<n>`).
- Shard assignment is sticky: a projector keeps a shard as long as it heartbeats. On stop, NATS reassigns. This is the standard JetStream durable consumer pattern.
- Each shard has its own Postgres connection (or its own backend entirely, see §8 for the projection store abstraction). Total projection throughput scales linearly with shard count.
- Projector reads events from NATS, resolves `PayloadReference` via the cache hierarchy (Tier 1 → 1.5 → 2 → 3), and writes projection state. Tier 1.5 is the hot path when the projector and the producing worker are colocated.

### 7.3 Stable identity

To get StatefulSet-style stable identity (required for Tier 2 disk cache continuity and for NATS durable consumer affinity), projectors and workers run as `StatefulSet` not `Deployment`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: noetl-projector
spec:
  serviceName: noetl-projector
  replicas: 4
  template:
    spec:
      containers:
        - name: projector
          env:
            - name: NOETL_SHARD_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: NOETL_NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
```

`NOETL_SHARD_ID = noetl-projector-0..3` is stable across restarts and maps directly to a NATS durable consumer name.

### 7.4 Projection store abstraction (port/adapter)

```python
class ProjectionStorePort(Protocol):
    async def save_projection(
        self, projection_id: str, state: bytes, version: int
    ) -> None: ...

    async def load_projection(
        self, projection_id: str
    ) -> Optional[Tuple[bytes, int]]: ...

    async def save_snapshot(
        self, aggregate_id: str, aggregate_type: str,
        snapshot: bytes, version: int
    ) -> None: ...

    async def load_snapshot(
        self, aggregate_id: str
    ) -> Optional[Tuple[bytes, int]]: ...

    async def query(
        self, projection_type: str, filters: Mapping[str, Any],
        pagination: Pagination
    ) -> AsyncIterator[Mapping[str, Any]]: ...
```

Adapters: Postgres (reference), cloud/serverless document and key-value stores, wide-column stores, columnar analytical stores, search stores, vector stores, and streaming materialized-view engines. Specific products are deployment choices, not architectural dependencies.

Implementation status:

- The first projection-store port is present in `repos/noetl/noetl/core/projection_store`.
- `ProjectionRecord` and `ProjectionSnapshot` define idempotent projection and snapshot writes.
- `projection_checksum()` provides deterministic JSON checksums for replay parity.
- `PostgresProjectionStore` is the reference adapter and writes to additive `noetl.projection` and `noetl.projection_snapshot` tables.
- The first transport-neutral reducer is present in `repos/noetl/noetl/core/projector`. `ReplayStateProjector` groups events by tenant, organization, and execution, orders by event position, folds them with the same replay-state reducer used by `GET /api/replay/state`, and writes lineage-rich `ProjectionRecord` rows with checksum and upcaster-registry metadata.
- The first projector process entrypoint is present at `python -m noetl.projector`. It wraps the reducer with a NATS durable pull consumer, stable shard identity, and modulo execution-id shard filtering so a StatefulSet replica only projects the events it owns.
- `noetl/noetl#457` adds optional projector `/metrics` and `/health` endpoints (`NOETL_PROJECTOR_METRICS_PORT` / `--metrics-port`) with counters for notifications, extracted events, shard-owned events, projection records, empty/unowned notifications, errors, and last batch gauges. Access logging is suppressed for scrape paths.
- `noetl/noetl#458` exports durable checkpoint gauges from successful projector writes: last source event id, event-time watermark, projected-at timestamp, latest projection lag, and max projection lag since process start.
- `NATSEventPublisher` is present in `repos/noetl/noetl/core/messaging`. It mirrors canonical event envelopes to subjects shaped as `noetl.events.<tenant>.<org>.<execution>.<shard>`, creates the event stream with a wildcard subject, and retries once after reconnect on publish failure.
- Frame lifecycle routes now can mirror `frame.dispatched`, `frame.started`, `frame.committed`, and `frame.failed` envelopes after the database transaction commits. Mirroring is opt-in via `NOETL_EVENT_MIRROR_ENABLED=true` and publish failures are logged but do not fail the frame API request.
- `noetl/noetl#459` extends the same opt-in mirroring to persisted `/api/events` lifecycle events and generated `command.issued` events, publishing only after the canonical database commit succeeds.
- Deployment wiring has started in `noetl/ops#102` and `noetl/ops#103`: the Helm chart gains an opt-in `noetl-projector` StatefulSet, projector ConfigMap, headless service, stable shard identity from the StatefulSet pod name, automatic server event-mirror env wiring when `projector.enabled=true`, and a named `metrics` port on `9090`.
- Projector checkpoint metadata landed in `noetl/noetl#455`: each replay-state projection write records `event_count`, `source_event_id`, `event_time_watermark`, `projected_at`, and `projection_lag_ms` in `ProjectionRecord.meta`. `noetl/noetl#458` exposes those fields as per-shard Prometheus gauges.
- The adapter currently supports:
  - `save_projection(record)` with version-monotonic upsert semantics;
  - `load_projection(projection_id)`;
  - `save_snapshot(snapshot)` with version-monotonic upsert semantics;
  - `load_snapshot(aggregate_id, aggregate_type=...)`.
- Wiring batch acceptance and other remaining server event write paths into the event mirror publisher, plus live mirrored-event projector validation, remain tracked by `noetl/noetl#437`.
- Non-Postgres projection adapters remain tracked by `noetl/noetl#439`.

Projection backend roles:

- **Operational projection stores** serve execution status, current frame state, user-facing API reads, and transactional admin surfaces.
- **Columnar analytical projection stores** are the high-volume analytical memory of the system: event lake tables, tenant/org audit timelines, PFT metrics, cost/billing facts, and queryable business histories. They are append-friendly and rebuildable from the event stream; they must not own unreplayable state.
- **Streaming materialized-view engines** maintain source/table/materialized-view/sink pipelines, incremental aggregations, work-queue state, and barrier-aligned derived state. They consume canonical events or table sources and emit derived updates, never replacing the canonical log.
- **Search/vector stores** serve retrieval shapes only. They are rebuilt from event/payload/projected source data and may lag without compromising correctness.

Every projection row should include enough lineage to support audit and replay comparison: `tenant_id`, `organization_id`, `execution_id` where applicable, source `event_id` or event-position range, projection version, and checksum.

Each projection type can target a different backend. The projector dispatches by the projection's configured `backend` (see §11 for the YAML).

---

## 8. Event store abstraction (port/adapter)

```python
class EventStorePort(Protocol):
    async def append(
        self, stream_id: StreamId, events: Sequence[EventEnvelope],
        expected_version: Optional[int]
    ) -> int: ...

    async def read(
        self, stream_id: StreamId, from_version: int = 0
    ) -> AsyncIterator[EventEnvelope]: ...

    async def subscribe(
        self, stream_pattern: str, consumer_group: str,
        from_position: ConsumerPosition
    ) -> Subscription: ...
```

Adapters (priority order):

1. **Postgres `noetl.event`** — canonical ledger and replay source by default. Partitioned by tenant/time/execution as volumes grow.
2. **NATS JetStream** — reference distribution stream. Subject = `noetl.events.<tenant>.<execution>.<shard>`. Durable consumers per projector / per worker. Events are persisted to the canonical ledger and mirrored to JetStream for low-latency fan-out.
3. **Apache Kafka / Confluent / MSK** — partition key = aggregate id; offset checks for `expected_version`.
4. **Google Pub/Sub** — topic per category, ordering key per aggregate, side store (Spanner / Firestore) for `expected_version`.
5. **Azure Event Hubs** — Kafka-compat mode reuses Kafka adapter; native mode uses Event Hubs SDK + Blob checkpoint store.
6. **Amazon Kinesis Data Streams** — partition key per aggregate, DynamoDB for version tracking, KCL for consumer coordination.

Implementation status:

- The first backend-neutral event-store port is present in `repos/noetl/noetl/core/event_store`.
- `EventRecord` defines the canonical append envelope used by adapters.
- `canonical_event_checksum()` serializes JSON deterministically with sorted keys and compact separators.
- `PostgresEventStore` is the reference adapter for `noetl.event`.
- The adapter currently supports:
  - `append(stream_id, events, expected_version=...)`
  - `read(stream_id, from_version=..., limit=...)`
  - per-stream expected-version conflict detection;
  - mapping to additive event envelope columns (`stream_id`, `stream_version`, aggregate/schema/tenant fields, `payload_ref`, `envelope_checksum`).
- NATS/Kafka/cloud-native stream adapters and projection-store ports remain tracked by `noetl/noetl#439`.

Adapter design constraints:

- Idempotent handlers as baseline; assume at-least-once delivery. Do not try to abstract exactly-once differences.
- Per-aggregate ordering only. No global ordering guarantee.
- Backend-specific retention / compaction / DLQ / monitoring stays out of the abstraction.
- Event schema evolution: every event carries `schema_version`. Adapters do not transform; upcasting lives in the projection layer.
- Configuration selects the backend at deploy time; same image runs anywhere.
- The adapter boundary separates **canonical append** from **distribution**. A deployment may use Postgres as the canonical append log and JetStream/Kafka as the fan-out transport, or a cloud-native log plus a compacted replay archive, but it must expose the same replay semantics.

---

## 9. Payload store abstraction (port/adapter)

```python
class PayloadStorePort(Protocol):
    async def store(
        self, data: bytes | AsyncIterator[bytes],
        content_type: str, metadata: Mapping[str, str]
    ) -> PayloadReference: ...

    async def fetch(
        self, reference: PayloadReference
    ) -> bytes | AsyncIterator[bytes]: ...

    async def exists(self, reference: PayloadReference) -> bool: ...

    async def delete(self, reference: PayloadReference) -> None: ...

    async def resolve_envelope(
        self, envelope: EventEnvelope
    ) -> EventEnvelope: ...

    async def externalize_envelope(
        self, envelope: EventEnvelope, threshold: int
    ) -> EventEnvelope: ...
```

Adapters: S3 (reference, covers SeaweedFS via S3-compat), GCS, Azure Blob, local filesystem.

Constraints:

- Content-addressed by SHA-256. Two events with identical large payloads share a reference. No duplicate uploads.
- Immutable on write. Versioning happens through new references, not in-place updates.
- Transparent to handlers via `resolve_envelope` / `externalize_envelope` middleware.
- Retention is reference-counted by event store retention; configurable TTL as safety net.
- Encryption at rest is per adapter.
- Streaming upload / download. No buffering full payloads in memory.

The cache hierarchy described in §6 (Tier 1 → 1.5 → 2 → 3) sits on top of this interface, transparent to user code.

---

## 10. Cloud distributed OS surfaces

This layer is what lets NoETL behave like a distributed business operating system for multitenant organizations. It provides identity, addressability, locality, replay, and resource accounting across clusters without coupling application logic to a specific cloud.

### 10.1 Unified resource locator

Every addressable thing in the system gets a stable URI:

```
noetl://tenant/<tenant>/org/<org>/cluster/<cluster>/region/<region>/zone/<zone>/node/<node>/process/<pid>/<kind>/<id>

Examples:
  noetl://tenant/acme/org/care-network/cluster/prod-1/region/us-central1/zone/us-central1-a/
         node/gke-noetl-pool-a-7b/process/1/worker/cpu-01

  noetl://tenant/acme/org/care-network/cluster/prod-1/region/global/none/none/none/
         stream/events/<execution>/<shard>

  noetl://tenant/acme/org/care-network/payloads/sha256/<sha256>
```

Tenants, organizations, workers, projectors, MCP servers, JetStream streams, Tier 3 payloads, cache entries, projection shards, and frame leases are all referenceable. The locator is the join key across the event store, projection store, and observability layer.

### 10.1.1 Multitenant isolation

Multitenancy is enforced at the event/payload boundary first, then projected outward:

- Event partitions include `tenant_id`, `organization_id`, and time/execution keys.
- Payload object keys include tenant/org prefixes and content digests; encryption context is tenant-scoped.
- Cache keys include tenant/org/execution. Shared cache layers may share infrastructure, not key space.
- Projection stores use row-level security or physical database/schema separation depending on the tenant isolation tier.
- Replay APIs require tenant/org scope and never scan a global stream without an explicit operator permission.
- Cross-tenant materialized analytics are allowed only through curated, governed projections with redaction rules encoded as projection code.

### 10.2 Topology-aware scheduling

Frame claim has an optional `locality` preference:

```text
POST /api/stages/{stage_id}/frames/claim
  body:
    worker_id: noetl://tenant/.../org/.../cluster/.../worker/cpu-01
    locality:
      prefer_node: <node_id>          # for Tier 1.5 colocation
      prefer_zone: us-central1-a      # for Tier 2 cache locality
      max_distance: zone | region | any
```

The server scheduler tries the closest match. Frames produced by a worker prefer to be reduced by a worker on the same node (Tier 1.5 hit) or in the same zone (Tier 2 hit). Cross-region only when local capacity is exhausted.

### 10.3 Autoscaling

The KEDA scaler reads two signals:

- `frame_backlog_total{stage_kind=...}` — pending frames waiting for a worker.
- `frame_p95_lease_duration` — moving p95 of how long frames take.

Autoscale formula: `desired_workers = max(1, ceil(frame_backlog_total / target_concurrent_frames_per_worker))`, clamped by per-cluster max. No provisioned capacity number.

For multi-cluster, the NATS JetStream supercluster routes the same `noetl.events.*` subjects across clusters. The scheduler can claim frames from peer clusters when local backlog has cleared. This is opt-in and gated by an egress cost budget.

### 10.4 Resilience

- Frame lease + cursor checkpoint = recovery primitive. Worker crash within a frame loses at most one frame's worth of work; the next worker resumes from the last committed cursor.
- Tier 3 is the durable read. Tier 1.5 / 2 are optimizations; their failure modes are graceful degradation, not data loss.
- Projection store writes are idempotent by `(stage_id, frame_id, partition_id)`. Replays are safe.
- Frame reaper (rebranded command reaper) republishes stale leases.

### 10.5 Quantum-cloud posture

"Quantum cloud" here means cloud infrastructure that can place work across heterogeneous compute and storage fabrics while preserving one event-sourced timeline per tenant organization. The runtime should assume future worker classes beyond CPU/GPU, including confidential compute, specialized accelerators, and quantum-provider task queues.

The contract stays the same:

- Specialized workers receive frames with typed input payload references.
- Provider submissions, callbacks, measurements, and result ingests are events with immutable payload references.
- External provider state is modeled as side effects with correlation/idempotency keys, not as hidden runtime state.
- Replay can reconstruct what was submitted, what was observed, and what state NoETL derived from it, even when the physical computation cannot be rerun deterministically.

---

## 11. Configuration

YAML, shared between Python and Rust runtimes:

```yaml
runtime:
  tenant_id: ${NOETL_TENANT_ID}
  organization_id: ${NOETL_ORGANIZATION_ID}
  node_id: ${POD_IP}                                # mandatory, used in locator + IPC hint
  cluster_id: ${NOETL_CLUSTER_ID}
  shard_id: ${NOETL_SHARD_ID}                       # for StatefulSet projectors / workers
  scheduler:
    locality_preference: zone                       # node | zone | region | any
    max_inflight_frames_per_worker: 4

event_store:
  canonical_backend: postgres                       # append-only replay ledger
  distribution_backend: nats-jetstream              # kafka | google-pubsub | azure-event-hubs | aws-kinesis | aws-msk
  connection:
    url: nats://nats.nats.svc.cluster.local:4222
    stream_prefix: noetl.events
  replay:
    snapshot_interval_events: 10000
    checksum_algorithm: blake3
    require_projection_parity: true

serialization:
  envelope_format: canonical-json
  tabular_payload_format: arrow-ipc-stream
  schema_registry:
    backend: file                                   # file | db | external
    path: /etc/noetl/schemas
  compression: zstd
  timezone: UTC

payload_store:
  backend: s3                                       # gcs | azure-blob | seaweedfs | local
  connection:
    endpoint: https://storage.googleapis.com
    bucket: noetl-payloads-prod
  threshold_bytes: 262144                           # 256 KB inline cap
  content_addressing: sha256
  encryption_at_rest: true
  cache:
    tier_1_memory_mb: 512
    tier_15_node_budget_mb: 1024                    # Arrow IPC budget per node
    tier_15_grace_seconds: 30
    tier_2_disk_gb: 10
    tier_2_disk_path: /var/cache/noetl/payloads
  gc:
    strategy: reference-count                       # | ttl
    ttl_days: 90

projection_stores:
  default:
    backend: postgres
    connection:
      dsn: postgresql://noetl:***@pg.noetl.svc:5432/noetl
  search:
    backend: search-store
    connection:
      hosts: ["http://search.search.svc:9200"]
  analytics:
    backend: columnar-analytics
    connection:
      dsn: ${NOETL_ANALYTICS_DSN}
  streaming:
    backend: streaming-materialized-view
    connection:
      dsn: ${NOETL_STREAMING_MV_DSN}

materializations:
  event_lake:
    backend: columnar-analytics
    source: event_store
    include_payload_refs: true
  operational_mvs:
    backend: streaming-materialized-view
    source: event_store
    barrier_interval_ms: 1000

snapshots:
  backend: postgres                                 # defaults to projection_stores.default

frame_policy_defaults:
  loop:
    size: 50
    duration_ms: 30000
    memory_bytes: 67108864
    parallelism: 1
  fanout:
    size: 1
    duration_ms: 5000
    memory_bytes: 16777216
    parallelism: 8
```

The same image runs anywhere. Backend changes are config-only.

---

## 12. Refactor plan (phased, additive)

### Phase 0 — Instrumentation (1 week)

Implementation status: partially shipped in `noetl/noetl#435`.

- Add the metrics in §4 to Grafana / VictoriaMetrics dashboards (already deployed).
- Baseline a fresh PFT v2 run on GKE. Capture the metric values and pin to memory.
- Add `noetl.stage` and `noetl.frame` tables via canonical Postgres DDL. Done in Phase 0 as additive DDL.
- Add canonical event-envelope schema validation, including tenant/org scope, `schema_name`, `schema_version`, `idempotency_key`, payload digest, and deterministic checksum fields. The additive columns are present; validation hardening remains incremental.
- Add replay harness: rebuild execution/frame/loop projections from `noetl.event` + payload store and compare checksums against live projection rows. The first replay API is shipped; full parity harness remains tracked by `noetl/noetl#440`.

Validation notes:

- Focused runtime/replay regression is green in `repos/noetl`.
- Local kind deployment is validated via `repos/ops/automation/infrastructure/kind.yaml` and `repos/ops/automation/development/noetl.yaml` using Podman.
- Latest local kind validation for `noetl/noetl#435`: image `local/noetl:2026-05-16-22-49`, health/replay/pod/log smokes passed, `/metrics` exposes the IPC counters, a temporary frame claim emitted `stream_version=1`, 64-character `envelope_checksum`, and non-null `catalog_id`, in-pod Arrow IPC TempStore round-trip passed, in-pod cursor-worker frame capture produced two Arrow-backed frames from three claimed rows, and the deployed server image imports `ReplayStateProjector`, `NATSProjectorWorker`, `NATSEventPublisher`, and the `python -m noetl.projector` entrypoint.
- Frame-loop local kind validation on 2026-05-17 (`noetl/noetl#435`, `noetl/e2e#22`, `noetl/ops#98`) completed PFT v2 execution `628959278765703700` in 33m10s. The run populated 60 `noetl.stage` rows and 5,570 `noetl.frame` rows, emitted 60 `stage.opened`, 5,570 `frame.dispatched`, and 5,570 `frame.committed` events, and emitted zero `frame.failed` events. The fixture used three `paginated-api` replicas with `PFT_RATE_LIMIT=500`; strict fixture 429 checks and worker/server error checks were clean in the final validation windows.
- Stage terminal events are now implemented and validated: the executor emits `stage.closed`, records `closed_event_id`, and marks the stage `COMPLETED` when the loop epoch finishes. Tracker `noetl/noetl#443` is closed; future failed/abandoned/reaper-specific gaps should be tracked as narrower bugs.
- Lineage validation on local kind image `localhost/local/noetl:2026-05-17-13-32` completed PFT v2 execution `629003028435042682` in 33m36s with `completed=true` and `failed=false`. Final counters: 60 `stage.opened`, 60 `stage.closed`, 5,562 `frame.dispatched`, 5,562 `frame.committed`, zero `frame.failed`, all 60 stages `COMPLETED`, `frame.command_id`/`claimed_event_id`/`terminal_event_id` populated on all 5,562 frames, and completed frames averaged 49.34 rows with max 50.
- Frame-mode local kind validation on image `localhost/local/noetl:2026-05-17-18-07` completed PFT v2 execution `629145120213828019` in 279.785s with `completed=true` and `failed=false`. Final counters: 5,498 frames, average 49.92 rows/frame, max 50, metrics present on every frame, all 10 facilities at 1000/1000 for the five patient domains, and MDS 224,443/224,443.
- Frame-lineage local kind validation on image `localhost/local/noetl:2026-05-17-18-56` completed PFT v2 execution `629166136403165640` in 269.156s with `completed=true` and `failed=false`. Final counters: 60 stages opened/closed, 5,500 frames, 5,440 frames with `parent_frame_id` (one root per stage), 5,500/5,500 `claimed_event_id` and `terminal_event_id` links populated, 5,500 `frame.dispatched`, 5,500 `frame.committed`, zero `frame.failed`, all 10 facilities at 1000/1000 for the five patient domains, and MDS 224,443/224,443.
- Frame-lifecycle local kind validation on image `local/noetl:2026-05-17-19-10` completed PFT v2 execution `629173479832551841` in 340.435s with `completed=true` and `failed=false`. Final counters: 60 stages opened/closed, 5,499 frames, 5,439 frames with `parent_frame_id` (one root per stage), 5,499/5,499 `claimed_event_id` and `terminal_event_id` links populated, 5,499 `frame.dispatched`, 5,499 `frame.started`, 5,499 `frame.committed`, zero `frame.failed`, all 10 facilities at 1000/1000 for the five patient domains, and MDS 224,443/224,443. The validation command passed `--set num_facilities=1 --set patients_per_facility=100`, but catalog execution overrides were ignored and the run used defaults `10/1000`; this is tracked in `noetl/cli#12`.
- Frame-stream lock-order validation on image `local/noetl:2026-05-17-19-51` completed PFT v2 execution `629193644754337792` in 487.855s with `completed=true` and `failed=false`. Final counters: 60 stages opened/closed, 5,496 frames, 5,436 frames with `parent_frame_id` (one root per stage), 5,496/5,496 `claimed_event_id` and `terminal_event_id` links populated, 5,496 `frame.dispatched`, 5,496 `frame.started`, 5,496 `frame.committed`, zero `frame.failed`, all 10 facilities at 1000/1000 for the five patient domains, MDS 224,443/224,443, and no frame endpoint deadlocks or 500s in the validation log window. Two prior validations on images `local/noetl:2026-05-17-19-26` and `local/noetl:2026-05-17-19-42` were cancelled after exposing frame event deadlocks; the fix is consistent lock acquisition before frame row mutation.
- Replay hardening now folds direct `event.stage_id`, `event.frame_id`, and `event.command_id` columns; records stage open/close event ids and frame claim/terminal event ids; and treats `frame.abandoned` as a deterministic lease-recovery transition. The golden replay corpus checksum was updated to cover these extra lineage fields.
- Frame replay parity now includes a deterministic frame projection checksum that can compare live `noetl.frame` rows with replayed frame state. The normalized parity surface includes frame/stage/parent/command ids, claim and terminal event links, status, row count, cursor metadata, emitted-event count, and Arrow IPC `rows_ref` summary fields (`sha256`, `schema_digest`, `row_count`, `media_type`, `ref`). Against local kind PFT execution `629193644754337792`, live and replayed frame projection checksums matched at `a65a8ce90d228332d3ce50958c6f41f1f8d584c36ee45ecd1645d61cb0e90cef` across 5,496 frames.
- Closed completed Phase 1 cleanup trackers after merged validation: `noetl/noetl#443` stage terminal projection, `noetl/noetl#444` distributed workload override handling via merged CLI fix, `noetl/noetl#446` frame recovery hardening, `noetl/noetl#447` frame payload replay parity, and `noetl/noetl#448` loop supervision event-id compatibility. Active hardening PRs are `noetl/noetl#453` for the frame claim hot path and `noetl/noetl#454` for execution status projection stability.
- Full repository pytest collection currently has legacy collection blockers unrelated to Phase 0; tracked by `noetl/noetl#440`.

Deliverable: dashboard URL + memory entry with baseline numbers, plus a replay parity report for the baseline run. No code change to hot paths.

### Phase 1 — Frame-shaped cursor loops (2 weeks)

Goal: collapse N single-row cursor claims into N/50 multi-row frame claims and allow selected steps to run the declared task pipeline once per frame.

- Extend `cursor_worker.py` to enforce the `frame_policy` payload now emitted alongside the existing cursor spec. The first implementation is in `noetl/noetl#435`: bounded claim windows are processed in-process and captured as Arrow IPC frame refs.
- New `POST /api/stages/{stage_id}/frames/claim` endpoint; under the hood it calls existing `claim_next_loop_indices` with `LIMIT = frame_policy.size`.
- Worker either iterates the claimed rows in-process (`frame.process: row`) or executes the task pipeline once with `frame.rows` (`frame.process: frame`). Both paths serialize the frame row window as Arrow IPC through TempStore. This pulls a narrow Tier 1.5 slice forward because serialization correctness is required before the frame API can be the sole path.
- Worker commits the frame with one event per frame instead of one per row.
- Migrate `test_pft_flow_v2.yaml` to opt in via `loop.spec.frame:` on each `mode: cursor` step. The high-volume PFT steps use `process: frame` to batch HTTP calls and Postgres writes from the declared playbook, rather than hiding the loop in Python.

Verification:

- Total `command.*` count drops from ~150k to < 20k on PFT v2.
- Wall time should drop versus the default row-processing baseline. The 2026-05-18 local kind validations improved the full PFT v2 run from ~31m21s to ~4m30s-~8m08s, with the latest clean lock-order validation favoring correctness over optimistic concurrent frame event writes.
- Replay parity stays green for frame state, loop progress, execution status, and frame-mode payload references. The parity gate compares live and replayed frame projection checksums, including Arrow IPC `rows_ref` digest and schema metadata.

### Phase 2 — Decentralized projection (2 weeks)

Goal: extract projection from server, run as a StatefulSet, scale independently.

- New `noetl-projector` binary entrypoint reusing the existing projection worker code.
- Helm chart adds the StatefulSet, NATS durable consumer per replica, projection-store-only DB user.
- Remove the in-process projection loop from the server. Server now appends canonical events and mirrors them to the distribution stream.
- Add per-shard projection lag/checkpoint metrics from durable projection metadata. Initial gauges are in `noetl/noetl#458`; dashboard wiring and live mirrored-event validation remain.

Verification:

- Postgres pool depth high-watermark drops by ~3× on PFT v2 (writer fan-out).
- Server CPU stops spiking during MDS bursts.

### Phase 3 — Arrow IPC Tier 1.5 (3 weeks)

Goal: add zero-copy data plane for colocated workers and projectors.

- Add `pyarrow` and `arrow-rs` (`arrow`, `arrow-ipc`) to dependencies. Mark as required for cursor/frame paths.
- Implement Tier 1.5 in `result_store.py` (Python) and equivalent in `repos/noetl/crates/noetl-core/src/storage/` (Rust).
- Extend `PayloadReference` with optional `IpcHint`.
- Producer worker writes RecordBatch to shm + Tier 3; emits hint in envelope.
- Consumer (projector, reducer, downstream stage) checks hint, attaches, falls back.
- Per-node IPC budget + grace + reaper.
- Metric: `tier15_hit_ratio` per consumer.

Verification:

- `tier15_hit_ratio` > 60% when projector is colocated with worker.
- End-to-end PFT v2 wall time targets ÷2 vs Phase 0 baseline.

### Phase 4 — Cloud OS surfaces (3 weeks)

Goal: lift the runtime from "well-behaved on one cluster" to "addressable, schedulable, autoscalable across clusters."

- Implement unified resource locator across all subsystems.
- StatefulSet identity for workers (not just projectors).
- KEDA scaler with frame backlog signal.
- Multi-cluster supercluster docs + an `ops` playbook to provision two GKE regions feeding the same NATS supercluster.
- Topology-aware scheduling via `locality` hint on claim.

### Phase 5 — Pluggable event store / payload store / projection store (rolling, separate PRs per adapter)

Goal: every backend class in §§ 8–9 has a working adapter, language-paired, behind a feature flag. Product choices stay deployment-specific; the compliance contract is architectural.

Order (mirroring the existing distributed plan):

1. NATS JetStream event store adapter (refactor existing to fit the new port). Python + Rust.
2. S3 payload store adapter (refactor existing to fit the new port). Python + Rust.
3. Postgres projection store adapter (refactor existing). Python + Rust.
4. Kafka event store adapter.
5. GCS payload store adapter.
6. Cloud key-value/document projection adapter.
7. Columnar analytical projection adapter.
8. Streaming materialized-view adapter.
9. … then the remainder in cloud-priority order.

Every adapter ships with:

- Compliance test suite (language-agnostic spec, run against both implementations).
- Replay parity suite for canonical events, payload references, snapshots, and projection checksums.
- Docker-compose entry for local development.
- Cloud-provisioning ops playbook in `repos/ops/automation/`.

### Phase 6 — Stage planner for fan-out / reduce (4 weeks)

Goal: extend the stage/frame model from loops to fan-out and reduce, completing the map-reduce shape.

- Stage `kind='fanout'`: explodes a single input into N partitions, each handed to a frame.
- Stage `kind='reduce'`: consumes M partitions, emits one output. Reduce frame waits on partition availability events instead of cursor rows.
- Replace the design in `distributed_fanout_mode_spec.md` with this materialized version.

---

## 13. Risks and open questions

- **Tier 1.5 GC under crash.** A producer worker that crashes after writing shm but before committing the frame leaves shm regions that no one will unlink. Mitigation: per-node `shm_unlink` sweep on worker start (scans `/dev/shm/noetl-*` and unlinks regions older than `tier_15_grace_seconds`).
- **NATS supercluster cost.** Cross-region replication of every event stream is not free. Mitigation: opt-in per execution; default is single-region.
- **Frame size tuning.** A frame too big means more work lost on crash; too small means coordination dominates. Mitigation: start with the §5.2 default, expose per-step override, measure with the §4 dashboard. Operators should choose `max_rows` from lost-work tolerance: a 50-row frame means a crash can replay up to 50 claimed cursor rows as one unit; high-cost or externally side-effecting steps should use smaller frames until idempotency is proven. Increase `lease_seconds` to at least the p99 frame runtime plus one heartbeat interval, and keep `max_attempts` low enough that repeated whole-frame failures page an operator instead of silently cycling.
- **Reduce-side back-pressure.** A reduce stage that is slower than its upstream fanout fills the projection store inbox. Mitigation: reuse the existing `max_inflight` concept at the stage level, not the worker level.
- **Multi-process per pod.** Some MCPs prefer multiple processes. Tier 1.5 then needs a node-local broker. Out of scope for v1; revisit if a real MCP demands it.

---

## 14. Source code anchors (current state)

For implementers. Existing code that this spec extends, not replaces:

| Concern | File | Key symbol |
|---|---|---|
| Loop expansion (parallel mode) | `noetl/core/dsl/engine/executor/commands.py` | `_create_command_for_step` |
| Cursor dispatch | `noetl/core/dsl/engine/executor/transitions.py` | `_issue_cursor_loop_commands` |
| Cursor worker | `noetl/worker/cursor_worker.py` | `execute_cursor_worker` |
| Worker tool dispatch | `noetl/worker/nats_worker.py` | `_execute_tool` |
| TempStore tiers | `noetl/core/storage/result_store.py` | `ResultStore.put / resolve` |
| TempStore tier enum | `noetl/core/storage/models.py` | `StoreTier` |
| NATS client | `noetl/core/messaging/nats_client.py` | `NatsClient.connect` |
| NATS K/V cache | `noetl/core/cache/nats_kv.py` | `NatsKv` |
| Claim API | `noetl/server/api/core/commands.py` | `claim_command` |
| Command reaper | `noetl/server/command_reaper.py` | `CommandReaper` |
| Schema DDL | `noetl/database/ddl/postgres/schema_ddl.sql` | `noetl.event`, `noetl.command` |

PFT v2 driver: `repos/e2e/fixtures/playbooks/pft_flow_test/test_pft_flow_v2.yaml` — six cursor steps, ~120k HTTP calls per execution, the canonical benchmark for every phase above.

---

## 15. Out of scope (deferred to future specs)

- Replacing the DSL with a different language. The DSL is fine; this spec rewires the execution layer underneath it.
- Replacing `noetl.event` with a different source of truth. Event log stays Postgres-backed by default; the event store port lets other backends mirror it.
- Replacing NoETL's existing MCP server architecture. Workers and MCPs are orthogonal.
- A new container orchestrator. We assume Kubernetes; the locator scheme is friendly to other orchestrators but they are not a v1 target.

---

## 16. Decision log (what changed vs the original event-store-design-prompt)

The original `event-store-design-prompt.md` (now archived) framed the problem as "add an event store abstraction layer." That framing is necessary but not sufficient. This revision changes the framing:

1. **Event sourcing becomes the system kernel.** The goal is not just to swap storage backends; it is to reproduce tenant/org system state at a requested time from canonical events plus immutable payloads.
2. **Shared memory becomes a product advantage, not just a cache.** The runtime uses Arrow IPC, local disk, distributed K/V, materialized views, and distributed indexes as a rebuildable shared-state fabric around the event log.
3. **Worker-side loop interpretation** remains the dominant immediate cost reduction. The PFT v2 baseline shows that even a perfect event store cannot save us from server-side per-row coordination overhead.
4. **A specific GC + admission story for Tier 1.5** (budget, grace, unlink sweep). The original handwaved this; we have to make it concrete or the shm region count will run away.
5. **A staged additive rollout** with frame-shaped cursor loops in Phase 1, before Arrow IPC and before pluggable backends. This lets us ship a measurable performance win in two weeks rather than waiting for a multi-quarter abstraction overhaul.

Other elements (three-layer model, backend adapters, content-addressed payloads, configuration schema) carry over from the original with edits to match the existing TempStore and projection-worker code that has shipped since the original was drafted. Product-specific analytical or streaming engines are intentionally not named as dependencies; NoETL adopts the underlying algorithms and contracts.

---

## 17. Implementation Roadmap

This section complements §12 (the phased refactor plan) with a phase dependency graph, per-phase acceptance checklist, replay parity gate, and operational readiness criteria. Section 12 defines *what* each phase builds; this section defines *when* each phase is ready to ship and what to do if it needs to be rolled back.

### 17.1 Phase dependency graph

Phases 1 and 2 can run in parallel once the Phase 0 baseline is captured. Phase 3 requires both because it depends on frame-shaped Arrow output (Phase 1) and colocated projectors (Phase 2).

```mermaid
graph LR
    P0["Phase 0\nInstrumentation\n1 week"] --> P1 & P2
    P1["Phase 1\nFrame-shaped\ncursor loops\n2 weeks"] --> P3
    P2["Phase 2\nDecentralized\nprojection\n2 weeks"] --> P3
    P3["Phase 3\nArrow IPC\nTier 1.5\n3 weeks"] --> P4
    P4["Phase 4\nCloud OS\nsurfaces\n3 weeks"] --> P5
    P5["Phase 5\nPluggable\nadapters\nrolling PRs"] --> P6
    P6["Phase 6\nFan-out / Reduce\n4 weeks"]
```

### 17.2 Pre-flight checklist (before Phase 0 begins)

These conditions must be true before work begins on Phase 0:

- [ ] `noetl.stage` and `noetl.frame` DDL reviewed and approved by database owner.
- [ ] Grafana / VictoriaMetrics dashboards provisioned with the §4 metric tile set (empty panels are acceptable at this stage).
- [ ] A reproducible trigger for a full PFT v2 run exists as an ops runbook entry and has been tested by a team member who did not write it.
- [ ] `NOETL_TENANT_ID`, `NOETL_ORGANIZATION_ID`, `NOETL_CLUSTER_ID` env vars injectable via Helm values in the target cluster.
- [ ] Replay harness skeleton (even a no-op stub) runs to completion without error against the current `noetl.event` table.
- [ ] Schema registry mount path (`/etc/noetl/schemas`) is provisionable from a ConfigMap.
- [ ] On-call alert routing confirmed for `frame_reaper_republish_rate` and `pg_pool_depth_highwatermark`.

### 17.3 Per-phase acceptance criteria

| Phase | Ship gate | Replay parity required | Rollback procedure |
|---|---|---|---|
| **0 — Instrumentation** | All §4 metrics non-null on dashboard from a complete PFT v2 run; baseline values pinned to memory | Replay harness exits 0; checksum report attached to memory entry | Drop `noetl.stage` / `noetl.frame` via inverse Alembic migration; zero runtime impact |
| **1 — Frame loops** | Total `command.*` count < 20k on PFT v2; wall time not regressed vs Phase 0 baseline | Frame state, loop progress, and execution status checksums match live projection | Set `frame_policy: null` on PFT v2 steps; disable frame claim endpoint; legacy command path unchanged |
| **2 — Decentralized projection** | Postgres pool depth < 30 sustained during MDS burst; per-shard projection lag metric visible on dashboard | Projection checksums match single-writer baseline | Re-enable in-process server projection loop; scale `noetl-projector` StatefulSet to 0 |
| **3 — Arrow IPC Tier 1.5** | `tier15_hit_ratio` > 60% on colocated consumer; PFT v2 wall time ≤ Phase 0 baseline ÷ 2 | Payload digest and projection checksums unchanged vs Phase 2 | Set `tier_15_node_budget_mb: 0`; admission control skips Tier 1.5 with no data-path change |
| **4 — Cloud OS surfaces** | Unified resource locator present on all event envelopes; KEDA scaler responds to frame backlog signal within 30 s | Locator fields do not alter event content digest; replay checksum unchanged | Disable KEDA scaler; revert locator injection to no-op middleware; locator fields are additive |
| **5 — Pluggable adapters** | Each adapter passes compliance + replay parity suite; Docker-compose local dev environment validated end-to-end | Python and Rust parity corpus checksums identical for each adapter under test | Revert backend config values to previous setting; no code removal required |
| **6 — Fan-out / reduce** | Stage `kind='fanout'` and `kind='reduce'` pass all PFT v2 fan-out phases; `distributed_fanout_mode_spec.md` superseded | Reduce-frame output checksums match single-partition baseline | Revert fan-out DSL steps to `mode: parallel`; stage/frame tables remain intact |

### 17.4 Replay parity release gate

Every phase after Phase 0 must pass all of the following before any merge to `main`:

```
[ ] Event envelope validation passes for 100% of events emitted in the phase's PFT v2 run.
[ ] Every snapshot records: event position, projection code version, upcaster versions,
    payload digest set, tenant encryption context, and deterministic fold checksum.
[ ] Replay harness runs start-to-finish against the phase's full event log and payload refs.
[ ] Execution state checksum (frame rows committed, loop progress) matches live projection.
[ ] At least one configured business projection type checksum matches live projection.
[ ] Python and Rust replay paths produce identical fold checksums on the golden corpus.
[ ] No event references an IpcHint path as its only payload copy
    (grep for events missing a Tier 3 payload_ref.uri).
[ ] Idempotency key present on 100% of externally retried transitions in the phase's events.
```

Replay parity failures block the phase merge. They are not deferred to the next phase.

### 17.5 Operational readiness (per phase shipped to production)

Before enabling any phase for a production tenant:

- [ ] Runbook exists in `repos/ops/automation/` covering: how to trigger a replay, how to compare checksums, how to roll back the phase, and how to scale the projector StatefulSet.
- [ ] On-call alerts live for `frame_reaper_republish_rate > 0.1/s` and `tier15_budget_exhaustion_total > 0`.
- [ ] Frame budget defaults reviewed against the tenant's actual execution profile (not only PFT v2).
- [ ] Tenant encryption context set and verified for all payload refs in the phase's event schema version.
- [ ] Retention and TTL policy for Tier 3 objects confirmed with legal / compliance for the tenant.
- [ ] Cross-tenant projection isolation verified: no query returns rows from a different `(tenant_id, organization_id)` pair without explicit operator permission.
