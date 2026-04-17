---
sidebar_position: 44
title: NoETL Async/Sharded Architecture (RisingWave-inspired)
description: Authoritative design spec for a trigger-free, horizontally-sharded, reference-linked-list execution model for NoETL.
---

# NoETL Async/Sharded Architecture

This document is the authoritative architectural reference for the NoETL runtime after the April 2026 redesign. It supersedes the trigger-based state projection and NATS-KV authoritative loop-state aspects of the prior plan (`noetl_enhancement_session_2026_04_14.md`, `noetl_distributed_processing_plan.md`, `noetl_schema_enhancements.md`).

## 1. Motivation

Two forces pushed us to redesign:

1. **Row-level trigger contention.** The `trg_execution_state_upsert` `AFTER INSERT FOR EACH ROW` trigger on `noetl.event` serialised every loop/shard/fan-in event onto the single `noetl.execution` row for an execution. Under the `test_pft_flow` workload (10 facilities × 1000 patients × 5 data types → ~10k concurrent `loop.item` events per step), this produced `canceling statement due to statement timeout / locking tuple (...) in relation "execution"` and stopped runs mid-flight.
2. **Volatile authoritative state.** Loop counters and collections were held in NATS KV (a volatile store) while also being partially reconstructed from Postgres on demand. A NATS restart or KV miss could drop a `loop.done` or re-dispatch already-completed iterations.

At the same time, the pattern emerging in modern streaming systems — most clearly in [RisingWave](https://github.com/risingwavelabs/risingwave) — is the opposite: push all state to shared durable storage, use epoch barriers for consistency, separate meta/compute/compactor, and shard computation by hash. We apply those patterns to NoETL's orchestration workload.

## 2. Invariants

Every later section derives from these. A change proposal that violates one of these invariants is out of scope for this document.

1. **`noetl.event` is append-only.** No updates, no triggers, no side-effect writes. Readers construct any higher-level view by scanning or projecting events.
2. **No Postgres triggers on hot-path tables.** All projections are computed by async server code that can be scaled and restarted independently of INSERTs.
3. **Nothing authoritative lives in memory.** Every in-process cache is a read-through accelerator. Dropping any cache (Python dict, NATS KV, Redis) must never change program behaviour — only latency.
4. **Linked-list references.** Every result envelope carries a `reference` to where the payload actually lives (object store / DB / KV) and a `parent_ref` to the producing envelope. The payload itself never rides inside an event.
5. **Server is the sole routing authority.** Workers emit events; they never synthesize `next.arc` decisions. All coordination flows through the server.
6. **Bounded replay on recovery.** After a crash the system replays at most the events since the last durable epoch boundary — not the full execution history.

## 3. Component Map

```
┌────────────────────────────────────────────────────────────────────┐
│  META-CONTROL (any server instance — leader-elected per role)       │
│  ├─ Shard Manager      (owns rows in noetl.execution_shard)         │
│  ├─ Reaper             (expired command.claimed → re-issue)         │
│  ├─ Checkpointer       (1 s epoch barrier → noetl.checkpoint)       │
│  └─ Compactor          (old partitions → manifest + DROP)           │
├────────────────────────────────────────────────────────────────────┤
│  COMPUTE (one ProjectionWorker per owned shard)                     │
│  ├─ Drains noetl.event for owned shards, 100 ms micro-batch         │
│  ├─ UPSERT noetl.execution.state in Python (no trigger)             │
│  ├─ Advance noetl.projection_checkpoint watermark                   │
│  └─ Resume from last checkpoint on restart                          │
├────────────────────────────────────────────────────────────────────┤
│  DURABLE STATE                                                      │
│  ├─ noetl.event             (partitioned, append-only)              │
│  ├─ noetl.result_ref        (+ parent_ref_id ← the linked list)     │
│  ├─ noetl.manifest(_part)   (aggregate / compacted manifests)       │
│  ├─ object store            (MinIO / PVC / GCS / S3 for payloads)   │
│  ├─ noetl.execution         (projection, eventually consistent)     │
│  ├─ noetl.execution_shard   (ownership / topology)                  │
│  ├─ noetl.checkpoint        (epoch boundaries)                      │
│  └─ noetl.projection_checkpoint (per-shard watermark)               │
├────────────────────────────────────────────────────────────────────┤
│  WORKER (any language; persist-before-emit middleware)              │
│  └─ Publishes on noetl.events.{shard}.> subjects                    │
└────────────────────────────────────────────────────────────────────┘
```

No worker-to-worker traffic. No WebSocket. NATS KV is a pure read-through cache and not consulted for any decision that affects event ordering or correctness.

## 4. RisingWave → NoETL Mapping

| RisingWave concept | NoETL mapping |
|---|---|
| Meta node | Shard Manager + Reaper + Checkpointer + Compactor (any server instance; leader-elected per role via `noetl.runtime` lease) |
| Compute node | Server instance running `ProjectionWorker` for owned shards |
| Compactor node | `compactor.py` background task (shared or dedicated server) |
| Hummock (LSM tree on S3) | `noetl.result_ref` + `noetl.manifest` + object store (MinIO/GCS/PVC); reference chain via `parent_ref_id` |
| Chandy-Lamport barrier | `checkpoint.committed` event every 1 s per shard |
| Epoch | `meta.epoch_id` snowflake stamped on every stateful event |
| Fragment → actor | Server-side handler → ProjectionWorker per shard |
| vnode hash partitioning | `hash(execution_id) % NOETL_SHARD_COUNT` |
| Lazy state load on rescale | Shard claim replays from `projection_checkpoint`; state is in Postgres + object store, no state migration |
| Exchange operator (local vs remote) | NATS JetStream local-subject vs targeted `noetl.events.{shard}.>` |
| Sink/source connectors | NoETL `tool.kind` plugins (http, postgres, duckdb, ...) |

## 5. Event Contract — Schema Version 3

Every `call.done` / `step.exit` / `loop.item` / `loop.shard.done` / `loop.fanin.completed` event carries this envelope (and nothing else of consequence) in `event.result`:

```json
{
  "status":    "ok|error|skipped|break|retry|...",
  "reference": { "ref_id": 1234567890, "type": "object_store|kv|db|eventlog", "uri": "s3://…" },
  "parent_ref":{ "ref_id": 1234567889 },
  "context":   { "rowcount": 1234, "next_page_token": "..." }
}
```

- `reference` — may be `null` when the result is intentionally void (side-effect-only task).
- `parent_ref` — points backward through the producing chain. For the first task in a pipeline, `parent_ref.ref_id = null`.
- `context` — scalars/small objects used by `next.arcs[].when` and downstream templates. Never contains secrets.

The DB enforces this shape with `chk_event_result_shape`; any event that carries payload data inline is rejected at INSERT.

### Result Reference linked list

`noetl.result_ref` gains one column:

```sql
ALTER TABLE noetl.result_ref
    ADD COLUMN IF NOT EXISTS parent_ref_id BIGINT
        REFERENCES noetl.result_ref(ref_id);
CREATE INDEX idx_result_ref_parent_chain
    ON noetl.result_ref (parent_ref_id)
    WHERE parent_ref_id IS NOT NULL;
```

To reconstruct the full lineage for a step, use a recursive CTE:

```sql
WITH RECURSIVE chain AS (
    SELECT * FROM noetl.result_ref WHERE ref_id = $terminal_ref
    UNION ALL
    SELECT r.* FROM noetl.result_ref r JOIN chain c ON r.ref_id = c.parent_ref_id
)
SELECT * FROM chain;
```

Served by the new endpoint `GET /api/executions/{id}/trace/{step}`.

### Persist-before-emit middleware (worker side)

Every worker result is funnelled through one function before any event is emitted:

```python
async def persist_before_emit(
    task_result: ToolResult,
    *,
    execution_id: int,
    step: str,
    task_label: str,
    pipeline_scope: PipelineScope,
) -> ResultEnvelopeV3
```

- Calls `ResultStore.put(…)` unconditionally — tools may not opt out.
- Looks up `parent_ref` from `pipeline_scope._prev` (the latest executed task envelope in the current `tool: []` pipeline).
- Emits `{status, reference, parent_ref, context}` only.
- On persistence failure: emits `{status:"error", error:{code:"REFERENCE_NOT_AVAILABLE", ...}}` so the server can jump the pipeline back to the producer task per the reference-only PRD §16.6.

`PipelineScope` holds `task_pointers: dict[str, Envelope]` keyed by task label (or `task_<index>`) and `_prev` for the latest-executed task. Scope is reset on each `tool: []` pipeline entry.

## 6. Projection Worker Protocol

### Trigger removal

The existing trigger is dropped unconditionally at DDL install time:

```sql
DROP TRIGGER IF EXISTS trg_event_to_execution ON noetl.event;
DROP FUNCTION IF EXISTS noetl.trg_execution_state_upsert();
```

This runs before any `CREATE TRIGGER` in `schema_ddl.sql`, so upgrades from the 25291fa2 interim trigger converge cleanly.

### New tables

```sql
-- per-shard projection watermark
CREATE TABLE IF NOT EXISTS noetl.projection_checkpoint (
    shard_id                INT PRIMARY KEY,
    last_projected_event_id BIGINT      NOT NULL DEFAULT 0,
    last_projected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    lag_ms                  INT
);

-- convenience column on the projection row
ALTER TABLE noetl.execution
    ADD COLUMN IF NOT EXISTS last_projected_event_id BIGINT;

-- covering index for shard-scoped drain
CREATE INDEX IF NOT EXISTS idx_event_shard_scan
    ON noetl.event (
        (abs(hashtextextended(execution_id::text, 0)) % 16),
        event_id
    );
```

(The modulus matches `NOETL_SHARD_COUNT`; we ship with 16, the index is rebuilt if the count changes.)

### Worker loop

```
loop:
    owned = shard_manager.owned_shards()
    for shard in owned:
        events = SELECT * FROM noetl.event
                 WHERE hash_shard(execution_id) = :shard
                   AND event_id > (SELECT last_projected_event_id FROM projection_checkpoint WHERE shard_id=:shard)
                 ORDER BY event_id
                 LIMIT :batch_size;
        if not events: continue
        for execution_id, batch in group_by_execution(events):
            state_delta = fold_events(batch)            # Python port of the old trigger CASE
            UPSERT noetl.execution (execution_id, state, last_projected_event_id) …
        UPDATE noetl.projection_checkpoint
           SET last_projected_event_id = max(events.event_id),
               lag_ms = extract(ms from now() - max(events.created_at)),
               last_projected_at = now()
         WHERE shard_id=:shard;
    sleep(max(0, batch_window_ms - elapsed))
```

- **Batching.** Within a batch, multiple events for the same `execution_id` are folded into a single UPSERT using `jsonb_object_agg` — one row-level lock acquisition per batch, not per event.
- **Idempotency.** Replaying any prefix of events produces the same `execution.state` (the projection functions are commutative per path + counters are monotonic).
- **Lag budget.** `lag_ms` is exported as a Prometheus gauge; alert at > 1000 ms sustained.

### Transport

Preferred: NATS JetStream durable consumer on `noetl.events.{shard}.>` with manual ack after DB commit. Fallback: polling on `event_id > watermark` with 100 ms tick (env `NOETL_PROJECTION_POLL_MS`). The two paths are mutually consistent because the DB watermark is the source of truth.

## 7. Shard Ownership Protocol

### Table

```sql
CREATE TABLE IF NOT EXISTS noetl.execution_shard (
    shard_id         INT PRIMARY KEY,
    owner_runtime_id BIGINT REFERENCES noetl.runtime(runtime_id),
    owner_instance   TEXT,
    epoch            BIGINT      NOT NULL DEFAULT 0,
    leased_until     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed rows 0..N-1 at init
```

### Claim / heartbeat / rebalance

Each server runs `shard_manager.py`:

- **Claim.** `UPDATE noetl.execution_shard SET owner_runtime_id = :me, owner_instance = :host, leased_until = now() + :lease, updated_at = now() WHERE (leased_until IS NULL OR leased_until < now()) AND shard_id = ANY(:candidates) RETURNING shard_id`. Candidate set is `all_shards \\ already_claimed_by_peer`.
- **Heartbeat.** Every `NOETL_SHARD_HEARTBEAT_SEC` (default 10 s) — `UPDATE ... SET leased_until = now() + :lease WHERE owner_runtime_id = :me`.
- **Rebalance.** On startup, a server claims up to `ceil(N / n_servers)` shards. When a peer dies, its `leased_until` expires (default lease 30 s) and any survivor picks the orphaned shard up in its next tick.

This mechanism reuses the same advisory-lock-style pattern as `runtime_leases.RuntimeLease` — we get fencing, lease renewal, and takeover for free.

### Subject routing

A worker computes the shard from `execution_id` and publishes on `noetl.events.{shard}.{event_type}`. Servers subscribe only to subjects for shards they currently own. Subject format: `noetl.events.{0..N-1}.{event_type}`.

Command dispatch from server → worker stays on `noetl.commands.{shard}.>` with Phase 4.3 targeted-dispatch subjects (`noetl.commands.{shard}.{worker_id}`) overlaid.

## 8. Epoch / Barrier Model

### Table

```sql
CREATE TABLE IF NOT EXISTS noetl.checkpoint (
    execution_id  BIGINT      NOT NULL,
    shard_id      INT         NOT NULL,
    epoch         BIGINT      NOT NULL,
    last_event_id BIGINT      NOT NULL,
    committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (execution_id, epoch)
);
```

### Event `meta.epoch_id`

Every stateful emission (server or worker) includes `meta.epoch_id` generated by `noetl.snowflake_id()`. This replaces and generalises the older `meta.loop_id` / `__loop_epoch_id` keys (those remain aliases during migration).

### Atomic barriers

Per-epoch unique partial indexes guarantee exactly-once emission:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_loop_fanin_completed
    ON noetl.event (execution_id, (meta->>'epoch_id'))
    WHERE event_type = 'loop.fanin.completed';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_checkpoint_committed
    ON noetl.event (execution_id, (meta->>'epoch_id'))
    WHERE event_type = 'checkpoint.committed';
```

`uidx_event_loop_done_loop_id` (already shipped) provides the same guarantee for `loop.done`.

### Checkpointer cadence

A background task per owned shard runs every 1 s:

1. `last_event_id := SELECT max(event_id) FROM noetl.event WHERE hash_shard(execution_id)=:shard AND event_id > :watermark`.
2. For each execution touched this tick, write a `checkpoint.committed` event (`meta.epoch_id`, `meta.last_event_id`).
3. `INSERT INTO noetl.checkpoint (…) VALUES (…) ON CONFLICT DO NOTHING`.

### Recovery

- Projection worker start: `SELECT max(last_event_id) FROM noetl.checkpoint WHERE shard_id=:s` → resume from there.
- `auto_resume.py` uses the same watermark to bound the replay window.
- Replay idempotence is guaranteed by the unique indexes for loop.done / fanin.completed / checkpoint.committed and by the deterministic `command_id` scheme (already shipped in `events.py`).

Target: `p99(now() - max(checkpoint.committed_at))` ≤ 1.5 s under steady-state load; total replay window after SIGKILL ≤ 5 s.

## 9. Compactor & Retention

Old partitions are collapsed and dropped to keep event-table I/O bounded:

- Shard-assigned background task reads completed executions in partitions older than `NOETL_RETENTION_DAYS` (default 30).
- For each execution, walk the `result_ref` chain via recursive CTE, produce a `noetl.manifest` row that preserves the linked-list summary (terminal ref, chain depth, per-step envelopes) and aggregate `manifest_part` rows for each step.
- Finally `DELETE FROM noetl.event WHERE execution_id = …` within the target partition.
- Partitions with all executions compacted are dropped directly (`DROP TABLE noetl.event_2026_q1` — instant cleanup per Postgres partitioning).

`GET /api/executions/{id}/trace/{step}` falls through to the `manifest` + `result_ref` lookup when events are absent, so historical traces remain reconstructable after retention.

Throughput target: ≥ 10k events/s/shard against MinIO/GCS tier.

## 10. Phase Plan

| Phase | Delivers | Key tables / files | Acceptance |
|---|---|---|---|
| **A** — Trigger off, projection in | Drop trigger; async ProjectionWorker per shard | `projection_checkpoint`; `noetl/server/projection_worker.py` | `test_pft_flow` completes with zero statement timeouts; projection lag p95 < 500 ms |
| **B** — Linked-list references | Event envelope v3; `parent_ref_id`; persist-before-emit; `/trace/{step}` | `result_ref.parent_ref_id`; `worker/persistence_middleware.py`, `worker/pipeline_scope.py` | event.result p99 bytes < 2 KB; CHECK rejects inline payload |
| **C** — Sharded execution | `execution_shard` table + `shard_manager` + NATS subject routing | `noetl/server/shard_manager.py`; `core/messaging/shard_subject.py` | 3 servers rebalance within 30 s on SIGKILL |
| **D** — Epoch barriers | `noetl.checkpoint`; 1-sec checkpoint events; `epoch_id` everywhere | `noetl/server/checkpointer.py`; `core/dsl/engine/executor/epoch.py` | SIGKILL at 50 % of 1000-item loop → resume ≤ 5 s; zero duplicate iterations |
| **E** — Strip in-mem authority | `ExecutionState` read-through; delete `try_claim_loop_done` | `core/dsl/engine/executor/state.py`; `core/cache/nats_kv.py` | Stop NATS mid-run; execution completes with identical event sequence |
| **F** — Compactor | Retention + manifest fallthrough | `noetl/server/compactor.py` | 30-day partition drops; `/trace/{step}` still serves from manifest |

Phases are delivered sequentially because each builds on the prior's contract (A's no-trigger clears the way; B's envelope v3 is pre-requisite for any consumer of reference chains; C's shards structure D's checkpoints; D's epochs gate E's elimination of KV; E's clean contract is required for F's compaction to be safe).

## 11. Configuration

| Env var | Default | Effect |
|---|---|---|
| `NOETL_SHARD_COUNT` | 16 | Number of compute shards |
| `NOETL_SHARD_HEARTBEAT_SEC` | 10 | Shard ownership heartbeat |
| `NOETL_SHARD_LEASE_SEC` | 30 | Expiry after which a shard is claimable by a peer |
| `NOETL_PROJECTION_BATCH_WINDOW_MS` | 100 | Projection worker micro-batch window |
| `NOETL_PROJECTION_BATCH_SIZE` | 500 | Max events projected per tick |
| `NOETL_PROJECTION_POLL_MS` | 100 | Polling fallback when NATS is unavailable |
| `NOETL_CHECKPOINT_INTERVAL_MS` | 1000 | Epoch barrier cadence |
| `NOETL_RETENTION_DAYS` | 30 | Compactor retention horizon |
| `NOETL_COMPACTOR_ENABLED` | `false` | Compactor opt-in during rollout |
| `NOETL_DEFAULT_STORE_TIER` | `gcs` prod / `minio` dev | Default backend for persist-before-emit |

All phases are backwards-compatible via these flags; individual phases are rolled out by flipping the relevant flag once the deploy is verified.

## 12. Observability

- **Projection lag.** `noetl_projection_lag_ms{shard}` gauge; SLO p95 < 500 ms.
- **Shard ownership.** `noetl_shard_owner{shard,instance}` info metric.
- **Epoch age.** `noetl_checkpoint_age_ms{shard}` gauge; SLO p99 < 1500 ms.
- **Event envelope bytes.** `noetl_event_result_bytes` histogram; SLO p99 < 2048 bytes.
- **Reference resolve latency.** `noetl_reference_resolve_ms{tier}`.
- **Compactor throughput.** `noetl_compactor_events_per_second{shard}`.
- **Status endpoint.** `GET /api/executions/{id}` reads straight from `noetl.execution` — no event scan; p99 < 10 ms.

## 13. Data Plane Separation (April 17 2026)

Implemented as the definitive fix for the distributed loop collection chain (bugs #1–#9). Inspired by RisingWave's architecture where the control plane orchestrates via references and the data plane stores/serves actual payloads.

### Problem

The Postgres tool returned `{rows: [{...}, ...], row_count, columns}` inline in event results. The worker's `_extract_control_context` either blocked `rows` (breaking downstream loop steps that depend on `{{ claim_patients.rows }}`) or passed them through (bloating events, causing cold-state rebuild failures, synthetic collection races, and violating the reference-only contract from the PRD).

### Solution

```
Before: Postgres tool → inline {rows, row_count} → event.result → context → template
After:  Postgres tool → TempStore.put(rows) → {status, reference, context: {row_count}} → event.result
                         ↓
         loop.in resolves reference → TempStore.resolve() → real rows → iteration
```

### Implementation

1. **Postgres tool** (`tools/postgres/executor.py`): `_externalize_rows_to_store()` persists SELECT result rows to TempStore and returns a reference envelope `{status, reference: {kind: "temp_ref", ref: "noetl://...", store: "kv"}, context: {row_count, columns}}`. Falls back to inline if TempStore is unavailable (backward compat for local/test mode).

2. **Loop collection resolver** (`common.py`): `_resolve_collection_if_reference()` detects reference-bearing dicts from rendered `loop.in` templates and resolves via `TempStore.resolve()`. Wired into `transitions.py` (dispatch), `rendering.py` (cold-state hydration), and `commands.py` (fallback re-render).

3. **Transparent `.rows` resolution** (`state.py`): `mark_step_completed` is now async. When a result carries a reference with `kind=temp_ref`, it eagerly resolves and caches `rows` in the step_results dict. Templates like `{{ claim_patients.rows }}` work without playbook changes.

4. **Context extraction** (`nats_worker.py`): `rows` and `columns` re-blocked in `_extract_control_context`. Reference dicts with `kind=temp_ref` pass through for downstream resolution.

### Invariants preserved

- No playbook DSL changes. `{{ step.rows }}` works via transparent resolution.
- Event payloads are compact: `{status, reference, context}` — no inline row data.
- Loop collections persist in NATS KV (`save_loop_collection`) for cold-state recovery.
- The reference-only PRD §7.1–§7.3 contract is now enforced for the Postgres tool path.

## 14. Security & Privacy

- Reference envelopes never carry secrets. `persist_before_emit` uses the existing context allow-list to strip credential-shaped keys.
- `result_ref.auth_reference` (already present) points at keychain records by ID only; never inlines credentials.
- Object-store URIs are treated as opaque; upstream access is gated by the existing auth provider.

## 15. What this document supersedes

- `noetl_enhancement_session_2026_04_14.md` §4 "Schema Analysis", §7 "Worker Communication Architecture Decisions" (re-affirmed), §8 Phase 1/P1.2 trigger-maintained `execution.state` — **superseded by §6 here**.
- `noetl_distributed_processing_plan.md` Phase 1 trigger-extension material — **superseded by §6 + §8 here**.
- `noetl_schema_enhancements.md` §6 Full Trigger and §4 `execution.state` trigger-driven updates — **superseded by §6 here**.
- What remains authoritative from the April 14 session: P0.1 atomic command dedup (shipped); P0.2 atomic `loop.done` via unique index (shipped); P0.3 `loop.started` event (shipped); P0.4 reaper (shipped); Phase 2 storage tier work (MinIO/PVC — shipped); Q1/Q2/Q3 worker communication decisions (NATS/HTTP split, no worker-to-worker, no WebSocket).

## 16. Related Documents

| Document | Role |
|---|---|
| `noetl_enhancement_session_2026_04_14.md` | Historical record of the preceding analysis; superseded where overlapping |
| `noetl_distributed_processing_plan.md` | 5-phase plan; Phase 1 trigger material superseded here |
| `noetl_schema_enhancements.md` | DDL reference; trigger sections superseded here |
| `reference-only-event-results-prd.md` | PRD for reference-only events; §7.2 `_prev` gap closed by §5 here |
| `distributed_fanout_mode_spec.md` | Distributed fan-out DSL semantics — still authoritative |
| `noetl_worker_communication.md` | NATS/HTTP split — still authoritative |
| `nats_kv_distributed_cache.md` | NATS KV role as a read-through cache — re-scoped by §2 invariant #3 |
