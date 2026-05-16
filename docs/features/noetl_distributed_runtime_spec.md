---
title: NoETL Distributed Runtime + Event Store Spec
description: Worker-side loop batching, Arrow IPC zero-copy data plane, decentralized projection, and cloud-agnostic event store / payload store / projection store abstractions for the NoETL distributed runtime.
sidebar_position: 30
---

# NoETL Distributed Runtime + Event Store Spec

Status: design proposal, ready for staged refactoring.
Owner: NoETL core (`repos/noetl`).
Companion specs that this revision builds on (do not re-spec):

- `noetl_async_sharded_architecture.md` — sharded projection workers, epoch barriers.
- `noetl_cursor_loop_design.md` — cursor-driven worker loops (already in production for PFT v2).
- `noetl_data_plane_architecture.md` — control/data plane split, reference-only event envelopes, TempStore tiers.
- `noetl_distributed_processing_plan.md` — phased rollout: P0 shipped, P1–P3 partial.
- `noetl_pft_performance_optimization.md` — PFT-specific tuning.
- `distributed_fanout_mode_spec.md` — designed but not shipped; this spec absorbs it.
- `nats_kv_distributed_cache.md` — NATS K/V scope.

Not in scope here: DSL surface changes, the playbook authoring guide, or the existing event-sourcing invariants. Those stay as is.

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

This spec proposes the next reduction step:

1. **Worker-side batched loop execution.** Workers claim and execute *frames* (multi-row windows) instead of single cursor rows. Per-fragment events drop by a factor equal to the frame size.
2. **Arrow IPC zero-copy data plane (Tier 1.5).** Co-located producers and consumers exchange large record batches via shared memory; remote consumers fall back to Tier 3 (S3/GCS/SeaweedFS).
3. **Decentralized projection.** Projection workers become pluggable, sharded, and horizontally scalable, with NATS consumer groups for fan-out and a stable identity scheme so they can re-attach to their shard after restart.
4. **Cloud-agnostic event store + payload store + projection store abstractions.** Port/adapter architecture for NATS JetStream / Kafka / Pub/Sub / Event Hubs / Kinesis; for S3 / GCS / Azure Blob / SeaweedFS; and for Postgres / DynamoDB / Firestore / Cosmos / Cassandra / ClickHouse / Elasticsearch / Vector DBs.

The end state is a **cloud-distributed operating system** in the NoETL sense: every compute, queue, and payload addressable via a unified resource locator; workers scale on real backlog signals; loops collapse to map-reduce style stages whose data plane uses shared memory whenever colocated and durable storage otherwise.

---

## 2. Non-goals

- This is not a rewrite of the NoETL DSL. Existing `next.arcs[]`, `set:`, `mode:` semantics stay.
- This does not replace Postgres as the default projection store. Postgres remains the reference; new backends are opt-in.
- This is not a new Arrow distribution mechanism. We use `pyarrow` and `arrow-rs` as-is.
- This is not a green-field event sourcing platform. We keep `noetl.event` as the source of truth; new layers wrap or complement it, they do not replace it.

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
       │  Kinesis                │  │  ClickHouse / ES         │
       │  (port + adapters)      │  │  (port + adapters)       │
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

- **Stage-shaped scheduling.** The server no longer thinks in cursor rows; it thinks in *frames*. A frame is a unit of work a worker can execute end-to-end, of bounded duration and bounded result size, and is independently recoverable.
- **Worker as the loop interpreter.** The inner DSL block of a loop step is interpreted inside the worker that owns the frame, not via N round-trips to the server.
- **Data plane separate from control plane.** Frame outputs flow as Arrow record batches over shared memory when possible and as content-addressed objects in Tier 3 always. The event store only ever carries lightweight manifests.

---

## 4. Workload baseline (instrument before refactor)

Before any code change ships, baseline the PFT v2 run with telemetry the team can reason from. This is the metric set every later phase is judged against.

Per execution, capture:

| Metric | How | Today's value (PFT v2 GKE 2026-05-15) |
|---|---|---|
| total `command.*` event count | `SELECT count(*) FROM noetl.event WHERE execution_id = $1 AND event_type LIKE 'command.%'` | ≈ 26k × 6 ≈ 150k |
| frame count | sum of cursor claims that returned > 0 rows | ≈ 26k |
| mean rows per frame | total rows / frame count | 1.0 (cursor today claims one row) |
| server CPU on `/claim` hot path | request-log percentiles from gateway | dominated by GKE pool pressure |
| Postgres pool depth high-watermark | `pg_stat_activity` poll | hit 50 waiters |
| NATS reschedule events | `kubectl get events -n nats` | 1 during facility-1 MDS |
| payload bytes written to Tier 3 | TempStore counter | not currently instrumented |
| projection store write rate | counter on `mark_step_completed` | single writer |
| execution wall time | `noetl.execution.end_time - start_time` | 3h 54m |

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
```

These coexist with `noetl.event` and `noetl.command`. Legacy tool steps are not migrated.

### 5.2 Frame policy

`frame_policy` is the configurable bound that decides how much work a single frame contains. The planner picks one of these strategies based on the step's DSL:

```yaml
frame_policy:
  size: 100                 # max rows per frame, optional
  duration_ms: 5000         # max wall-time per frame, optional
  memory_bytes: 67108864    # max in-flight Arrow buffer per frame
  parallelism: 4            # how many frames can be in-flight per worker
```

For PFT v2, a sensible default is `{ size: 50, duration_ms: 30000, memory_bytes: 64MB, parallelism: 1 }`. That collapses today's 26k frames (size=1) to ~520 frames, a 50× drop, while keeping each frame under a half minute so worker crashes lose at most half a minute of work.

### 5.3 Claim / heartbeat / commit API

New endpoints on the NoETL server, additive to the existing `/api/commands/*`:

```text
POST /api/stages/{stage_id}/frames/claim
  body: { worker_id, want, max_inflight }
  returns: [ { frame_id, cursor, lease_until, dsl_ref, frame_policy } ... ]

POST /api/frames/{frame_id}/heartbeat
  body: { worker_id, cursor }
  returns: { lease_until }

POST /api/frames/{frame_id}/commit
  body: { worker_id, cursor, output_ref, row_count, status }
  returns: { ok, next_action }   # may immediately hand the worker the next frame
```

The HTTP surface is the operational fallback. The primary path uses NATS JetStream pull consumers (see §6) for lower-latency claim and built-in lease semantics.

### 5.4 Server's narrower role

After the refactor:

- For a loop step the server emits **one** `stage.opened` event, mints frames lazily as workers ask, and emits **one** `stage.closed` when all frames commit.
- The server **does not** touch per-row state. Cursors are opaque; the server only records the latest committed cursor per frame.
- The server **does not** issue per-row `command.issued` events. Frame claims are observable via `stage` and `frame` rows plus a single `frame.dispatched` event per claim.

The current `command_reaper` repurposes to **frame reaper**: it scans `noetl.frame` for `lease_until < now() AND status IN ('CLAIMED','RUNNING')`, marks the lease abandoned, and republishes the frame. Same correctness guarantees; smaller scan surface.

---

## 6. Data plane: Arrow IPC zero-copy (Tier 1.5)

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
    tier3_uri: str           # noetl://payloads/<sha256>
    sha256: str
    media_type: str          # "application/x-arrow+stream"
    rows: int
    bytes: int

    # Tier 1.5 fast-path hint, may be None or stale
    ipc: Optional[IpcHint] = None

@dataclass
class IpcHint:
    node_id: str             # noetl://cluster/<id>/node/<id>
    shm_name: str            # /noetl-<execution>-<frame>-<seq>
    schema_digest: str       # quick sanity check before attach
    valid_until: datetime    # writer-promised minimum lifetime
```

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

### 6.6 Why Arrow, not raw bytes

- Columnar layout is the right shape for the heavy paths (Postgres bulk reads, DuckDB joins, fanout reducers, projection writes to ClickHouse).
- Zero-copy between Python and Rust workers via the C Data Interface comes for free with Arrow. Important once we run a mix of `pyarrow`-using Python workers and `arrow-rs` Rust workers on the same pod.
- The wire schema is self-describing; no separate registry needed.

---

## 7. Decentralized projection

### 7.1 Current state

`noetl_async_sharded_architecture.md` already specifies async projection workers and epoch barriers. The projection worker skeleton exists. What is not yet decentralized: the projection still runs **inside the server process**, and the projection write rate caps at the server's single-writer Postgres connection.

### 7.2 Refactor

- Extract projection into its own deployable: `noetl-projector`. Same image, different entrypoint.
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

Adapters: Postgres (reference), DynamoDB, Firestore, Cosmos DB, Cassandra/ScyllaDB, ClickHouse (analytical projections only), Elasticsearch/OpenSearch (search projections only), Qdrant/Milvus/Weaviate (vector projections only).

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

1. **NATS JetStream** — reference implementation. Subject = `noetl.events.<execution>.<shard>`. Durable consumers per projector / per worker.
2. **Apache Kafka / Confluent / MSK** — partition key = aggregate id; offset checks for `expected_version`.
3. **Google Pub/Sub** — topic per category, ordering key per aggregate, side store (Spanner / Firestore) for `expected_version`.
4. **Azure Event Hubs** — Kafka-compat mode reuses Kafka adapter; native mode uses Event Hubs SDK + Blob checkpoint store.
5. **Amazon Kinesis Data Streams** — partition key per aggregate, DynamoDB for version tracking, KCL for consumer coordination.

Adapter design constraints:

- Idempotent handlers as baseline; assume at-least-once delivery. Do not try to abstract exactly-once differences.
- Per-aggregate ordering only. No global ordering guarantee.
- Backend-specific retention / compaction / DLQ / monitoring stays out of the abstraction.
- Event schema evolution: every event carries `schema_version`. Adapters do not transform; upcasting lives in the projection layer.
- Configuration selects the backend at deploy time; same image runs anywhere.

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

### 10.1 Unified resource locator

Every addressable thing in the system gets a stable URI:

```
noetl://cluster/<cluster>/region/<region>/zone/<zone>/node/<node>/process/<pid>/<kind>/<id>

Examples:
  noetl://cluster/prod-1/region/us-central1/zone/us-central1-a/
         node/gke-noetl-pool-a-7b/process/1/worker/cpu-01

  noetl://cluster/prod-1/region/global/none/none/none/
         stream/events/<execution>/<shard>

  noetl://payloads/<sha256>
```

Workers, projectors, MCP servers, JetStream streams, Tier 3 payloads, and frame leases are all referenceable. The locator is the join key across the event store, projection store, and observability layer.

### 10.2 Topology-aware scheduling

Frame claim has an optional `locality` preference:

```text
POST /api/stages/{stage_id}/frames/claim
  body:
    worker_id: noetl://cluster/.../worker/cpu-01
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

---

## 11. Configuration

YAML, shared between Python and Rust runtimes:

```yaml
runtime:
  node_id: ${POD_IP}                                # mandatory, used in locator + IPC hint
  cluster_id: ${NOETL_CLUSTER_ID}
  shard_id: ${NOETL_SHARD_ID}                       # for StatefulSet projectors / workers
  scheduler:
    locality_preference: zone                       # node | zone | region | any
    max_inflight_frames_per_worker: 4

event_store:
  backend: nats-jetstream                           # kafka | google-pubsub | azure-event-hubs | aws-kinesis | aws-msk
  connection:
    url: nats://nats.nats.svc.cluster.local:4222
    stream_prefix: noetl.events

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
    backend: elasticsearch
    connection:
      hosts: ["http://elastic.search.svc:9200"]
  analytics:
    backend: clickhouse
    connection:
      dsn: clickhouse://clickhouse.analytics.svc:9000/noetl

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

- Add the metrics in §4 to Grafana / VictoriaMetrics dashboards (already deployed).
- Baseline a fresh PFT v2 run on GKE. Capture the metric values and pin to memory.
- Add `noetl.stage` and `noetl.frame` tables via Alembic migration (empty initially).

Deliverable: dashboard URL + memory entry with baseline numbers. No code change to hot paths.

### Phase 1 — Frame-shaped cursor loops (2 weeks)

Goal: collapse N single-row cursor claims into N/50 multi-row frame claims, with no other architectural change.

- Extend `cursor_worker.py` to accept a `frame_policy` payload alongside the existing cursor spec.
- New `POST /api/stages/{stage_id}/frames/claim` endpoint; under the hood it calls existing `claim_next_loop_indices` with `LIMIT = frame_policy.size`.
- Worker iterates the returned rows in-process, accumulating results to a local list (Arrow IPC comes in Phase 3; for now use plain JSON).
- Worker commits the frame with one event per frame instead of one per row.
- Migrate `test_pft_flow_v2.yaml` to opt in via `frame_policy:` on each `mode: cursor` step.

Verification:

- Total `command.*` count drops from ~150k to < 20k on PFT v2.
- Wall time should drop modestly (less server CPU on /claim) but not the headline target yet.

### Phase 2 — Decentralized projection (2 weeks)

Goal: extract projection from server, run as a StatefulSet, scale independently.

- New `noetl-projector` binary entrypoint reusing the existing projection worker code.
- Helm chart adds the StatefulSet, NATS durable consumer per replica, projection-store-only DB user.
- Remove the in-process projection loop from the server. Server now only writes events.
- Add per-shard projection lag metric.

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

Goal: every backend in §§ 8–9 has a working adapter, language-paired, behind a feature flag.

Order (mirroring the existing distributed plan):

1. NATS JetStream event store adapter (refactor existing to fit the new port). Python + Rust.
2. S3 payload store adapter (refactor existing to fit the new port). Python + Rust.
3. Postgres projection store adapter (refactor existing). Python + Rust.
4. Kafka event store adapter.
5. GCS payload store adapter.
6. DynamoDB projection store adapter.
7. … then the remainder in cloud-priority order.

Every adapter ships with:

- Compliance test suite (language-agnostic spec, run against both implementations).
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
- **Frame size tuning.** A frame too big means more work lost on crash; too small means coordination dominates. Mitigation: start with the §5.2 default, expose per-step override, measure with the §4 dashboard.
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

The original `event-store-design-prompt.md` (now archived) framed the problem as "add an event store abstraction layer." That framing is necessary but not sufficient. This revision adds three things the original did not address:

1. **Worker-side loop interpretation** as the dominant cost reduction, not just the storage abstraction. The PFT v2 baseline shows that even a perfect event store cannot save us from server-side per-row coordination overhead.
2. **A specific GC + admission story for Tier 1.5** (budget, grace, unlink sweep). The original handwaved this; we have to make it concrete or the shm region count will run away.
3. **A staged additive rollout** with frame-shaped cursor loops in Phase 1, before Arrow IPC and before pluggable backends. This lets us ship a measurable performance win in two weeks rather than waiting for a multi-quarter abstraction overhaul.

Other elements (three-layer model, backend adapters, content-addressed payloads, configuration schema) carry over from the original with edits to match the existing TempStore and projection-worker code that has shipped since the original was drafted.
