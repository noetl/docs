---
sidebar_position: 43
title: NoETL Enhancement Session — April 14 2026
description: Full record of the architectural analysis and planning session covering distributed processing bugs, streaming architecture comparison, storage layer, and the 5-phase enhancement plan.
---

# NoETL Enhancement Session — April 14 2026

This document records the full analysis, decisions, and outputs of the April 14 2026 architectural planning session. It covers the comparison with streaming processing system architecture concepts, the analysis of NoETL's distributed bugs, the `test_pft_flow` workload review, the shared storage decision, and the 5-phase enhancement plan.

---

## 1. Starting Context

Active work at session start:
- `test_pft_flow` execution `604876797720658689` running (assessments ✅, conditions ✅, medications ~38% in progress)
- Go/no-go criterion: `validation_log` = 10 rows with 1000/1000 per facility for all 5 data types
- Known issues: over-dispatch bug (`noetl/noetl#345`), DSL v2 migration complete through PR #354
- CLI baseline: `noetl 2.13.0` at `/Volumes/X10/dev/cargo/bin/noetl`

---

## 2. NoETL Distributed Architecture — Analysis

### Component map

```
Server (FastAPI, port 8082)
  ├── Engine: handle_event() → evaluate next.arcs → issue commands
  ├── PostgreSQL: event table (partitioned by execution_id), execution projection, result_ref, manifest
  ├── NATS JetStream: lightweight command notifications (server → worker)
  └── GCS/S3: externalized results (> 64KB) and loop collections

Worker (Python, nats_worker.py ~3800 lines)
  ├── NATS subscriber: receives command notifications
  ├── HTTP GET /api/commands/{event_id}: fetches full command context
  ├── Tool executors: postgres, http, duckdb, python, snowflake, transfer, playbook, noop, script
  └── HTTP POST /api/events (or /batch): emits results back to server

NATS KV (volatile, in-memory, 1h TTL)
  ├── Loop collection: exec.{eid}.loop_coll:{step}:{loop_event_id}
  └── Loop counters: exec.{eid}.loop:{step}:{event_id}
```

### Key DSL concepts (v2 canonical)

- `workflow` → `step` → `tool` (pipeline of tasks) → `next` (arc routing)
- `input`/`output`/`set` for data binding; `_ref` suffix for unresolved references
- `loop { in, iterator, spec { mode: sequential|parallel, max_in_flight } }`
- `task_sequence`: single worker executes a multi-task pipeline atomically
- Server is sole routing authority; workers never synthesize routing decisions

---

## 3. Streaming Architecture Concepts vs NoETL

### What streaming-oriented systems do differently

Research into modern streaming database architecture revealed these patterns relevant to NoETL:

| Concept | Streaming system approach | NoETL equivalent / gap |
|---|---|---|
| Exactly-once dispatch | Chandy-Lamport barrier → consistent snapshot | Advisory lock on `command.claimed`; races in `handle_event()` |
| Actor model | Work partitioned to stateless actors per data shard | Loop parallel dispatch to workers via NATS |
| Incremental state | Only changed results recompute | Full event log scan on state reconstruction |
| Built-in backpressure | Implicit in dataflow graph | Reactive AIMD on 503 + pool saturation detection |
| Object-storage state | State in S3/GCS (cheap, persistent), local SSD = cache | NATS KV (volatile) + GCS for large results |
| Distributed fan-out | Server splits work into independent actor assignments | Specced (`distributed_fanout_mode_spec.md`) but not implemented |

### Key conclusion

NoETL's architecture (event-sourced orchestration + NATS + PostgreSQL) is sound for its workload class (batch ETL, paginated API extraction, queue-based parallel processing). The streaming-oriented concepts that directly apply are:

1. **Atomic deduplication** — replace read-check-write with `INSERT ... ON CONFLICT DO NOTHING`
2. **Event-table as state authority** — loop state belongs in `noetl.event`, not volatile NATS KV
3. **Projection tables** — `noetl.execution` already is one; extend it with loop progress
4. **Object storage for all durable data** — MinIO for local, GCS/S3 for cloud

---

## 4. Schema Analysis

### Existing schema strengths

- `noetl.event`: range-partitioned by `execution_id` (quarterly partitions), instant cleanup via `DROP TABLE`
- `loop_event_id` / `__loop_epoch_id` already indexed in `meta` JSONB
- `current_index`, `current_item` dedicated columns on event table
- `noetl.execution`: **projection table** updated by trigger `trg_execution_state_upsert`; has `state JSONB` column
- `noetl.result_ref`: `store_tier`, `physical_uri`, `correlation` JSONB for loop/pagination tracking
- `noetl.manifest` + `manifest_part`: aggregated result manifests

### Decision: loop_fanin and loop_state entirely in event table

No new tables needed. Design:

**Loop state** (replaces NATS KV as authority):
- `loop.started` event: `meta = {loop_id, collection_size}`, `context = {collection_ref}`
- `loop.item` events: `current_index = N`, `meta = {loop_id, iter_index}`
- Recovery query counts `command.completed` WHERE `meta->>'loop_id' = X`

**Fan-in tracking** (new, for distributed fan-out):
- `loop.fanout.started`: `meta = {loop_id, total_shards: N}`
- `loop.shard.done/failed`: `meta = {loop_id, shard_id, command_id}`
- Fan-in check: single indexed query on `idx_event_loop_id_type`
- `loop.fanin.completed`: atomic via unique index `uidx_event_loop_fanin_completed_loop_id`

**`noetl.execution.state`** maintained by trigger for live loop progress:
```json
{
  "loop":   { "{step}": { "loop_id", "total", "done", "failed", "collection_ref", "completed" } },
  "fanout": { "{step}": { "loop_id", "total_shards", "done", "failed", "status" } }
}
```

### Critical new unique indexes

```sql
-- Prevents duplicate command dispatch (fixes over-dispatch race)
CREATE UNIQUE INDEX uidx_event_command_issued_command_id
    ON noetl.event (execution_id, (meta->>'command_id'))
    WHERE event_type = 'command.issued' AND meta ? 'command_id';

-- Prevents duplicate loop.done (fixes premature loop termination race)
CREATE UNIQUE INDEX uidx_event_loop_done_loop_id
    ON noetl.event (execution_id, (meta->>'loop_id'))
    WHERE event_type = 'loop.done' AND meta ? 'loop_id';

-- Fast fan-in count queries
CREATE INDEX idx_event_loop_id_type
    ON noetl.event (execution_id, (meta->>'loop_id'), event_type)
    WHERE meta ? 'loop_id';
```

---

## 5. Shared Kubernetes Storage for Worker Data Exchange

### Decision: MinIO (kind/local) + gcsfuse-csi (GCP)

**Raw NFS PVCs rejected** because: concurrent write locking issues, metadata latency for glob patterns, zone locality constraints, incompatibility with object storage workflows.

**Chosen approach:**

| Tier | Kind/local | GCP |
|---|---|---|
| Large intermediate files | MinIO (S3-compatible, RWO PVC-backed) | gcsfuse-csi (GCS bucket as local FS) |
| Static reference datasets | hostPath or NFS RWX PVC | Filestore NFS RWX PVC |
| Small results (<10MB) | NATS KV / Object Store | NATS KV / Object Store |

**`StoreTier` extension:**
```python
MINIO = "minio"   # MinIO endpoint (S3-compatible); physical_uri = s3://bucket/key
PVC   = "pvc"     # Local mount path; physical_uri = /data/exec/{eid}/step/name.parquet
```

**DuckDB benefit**: with PVC/FUSE mount, DuckDB reads Parquet directly:
```sql
SELECT * FROM '/data/exec/604876.../step_extract/result.parquet'
-- no upload/download cycle needed
```

---

## 6. `test_pft_flow` Workload Analysis

### What the playbook does

```
10 facilities × 1000 patients × 5 data types = 50,000 total work items

Per facility (sequential outer loop):
  setup_facility_work → seed 5,000 queue rows (5 types × 1,000 patients)
  For each data type [assessments, conditions, medications, vital_signs, demographics]:
    load_patients → COUNT pending
    claim_patients → SELECT FOR UPDATE SKIP LOCKED, claim 100
    fetch_{type} → loop { parallel, max_in_flight: 20 }
                    each patient: init_page → fetch_page (HTTP) → save_page (postgres) → paginate
    → back to load_patients until 0 remaining
  prepare_mds_work → build_mds_batch_plan (python) → run_mds_batch_workers (sub-playbook, serial)
  validate_facility_results → log_facility_validation → mark_facility_processed
Final: validate_all_results → check_results (python assert) → end
```

### Does this workload need a streaming processing system?

**No.** Every operation is within NoETL's existing toolset:
- PostgreSQL `FOR UPDATE SKIP LOCKED` = the concurrency primitive
- `loop { mode: parallel, max_in_flight: 20 }` = the parallelism primitive
- `noop` policy `jump` = the pagination primitive
- `playbook` tool = sub-workflow dispatch
- Python = batch plan computation and final assertion

Streaming concepts (continuous materialized views, sub-100ms freshness, event-time windows) are not relevant to a batch queue-draining ETL pipeline.

### Actual bugs in NoETL for this workload

**Bug 1 — Premature `loop.done`** (the patient loss bug, AHM-4280..4284):

The playbook's `check_results` step explicitly detects it:
```
assessments_queue_done may be 1000 but assessments_done << 1000
(only ~1 batch worth / ~100 patients saved) due to premature cutoff
```

Root cause: `completed_count >= collection_size` check is non-atomic. Two concurrent `call.done` coroutines both read count=N-1, both increment to N, both attempt to claim `loop.done` via NATS KV `try_claim_loop_done`. Under race or NATS KV failure, `loop.done` fires before all batch results are saved.

**Bug 2 — Over-dispatch** (`noetl/noetl#345`):

`handle_event()` read-check-write pattern allows two concurrent coroutines to both pass the deduplication guard and both insert `command.issued` for the same step, causing workers to process the same batch twice.

Evidence: `run_duckdb_probe` issued 12 times vs expected 5 in `tooling_non_blocking` fixture.

**Bug 3 — Loop state loss on restart:**

NATS KV stores loop collection and counters. Server restart or NATS outage loses this; recovery may re-dispatch already-completed iterations or miss `loop.done`.

**Bug 4 — Stale claim reclaim in wrong layer:**

Each `load_patients_for_*` step contains:
```sql
WITH reclaim_stale AS (
  UPDATE pft_test_patient_work_queue SET status='pending'
  WHERE status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'
)
```
This is a workaround for missing orchestration-level claim expiry. If the last batch crashes, no new cycle triggers and those patients are permanently stuck claimed.

---

## 7. Worker Communication Architecture Decisions

### Three questions answered

**Q: Should workers communicate directly via NATS?**
**A: No.** Server is routing authority. Fan-in is a server-side event count query, no inter-worker coordination needed. Direct worker-to-worker comms would bypass event persistence, dedup, and routing — creating invisible state and unrecoverable failures.

**Q: Should we add WebSocket/socket connections?**
**A: No.** NATS already provides persistent connection, reconnection, flow control, and server-push semantics. WebSocket would duplicate NATS with more failure modes.

**Q: Should event emission switch from HTTP to NATS?**
**A: Yes, for high-frequency events (Phase 4, opt-in).** Split:

| Keep HTTP | Switch to NATS |
|---|---|
| `command.claimed` (sync advisory lock result) | `command.completed` / `command.failed` |
| `GET /api/commands/{id}` (command context fetch) | `command.heartbeat` |
| Registration, health, status | `loop.shard.done` / `loop.shard.failed` |
| | `call.partial` (streaming chunks) |

NATS stream: `NOETL_WORKER_EVENTS`, subjects `noetl.events.>`, WorkQueuePolicy retention, 1h MaxAge, 64KB MaxMsgSize.

Performance expectation: event emission latency drops from ~5–15ms (HTTP) to ~0.5–2ms (NATS publish); throughput from ~500 events/s to ~20,000 events/s per worker.

---

## 8. The 5-Phase Enhancement Plan

Full details in `noetl_distributed_processing_plan.md`.

### Phase 0 — Correctness (blocks everything)

| Task | Fix | AC |
|---|---|---|
| P0.1 Atomic command dedup | Unique index + catch `UniqueViolationError` on `command.issued` INSERT | `issued_count == terminal_count` in all fixtures |
| P0.2 Atomic loop.done | `ON CONFLICT DO NOTHING RETURNING event_id`; only returning coroutine routes | 1000/1000 in `test_pft_flow` for assessments |
| P0.3 Loop state in event table | `loop.started` event; recovery from event count query; NATS KV = cache only | Loop resumes after server kill at 50% |
| P0.4 Reaper claim expiry | Detect heartbeat timeout, re-enqueue; remove stale-reclaim SQL from playbooks | Integration test: worker suspend > timeout → reaper re-enqueues |

### Phase 1 — Schema

New indexes (3 unique + 1 query), new loop event types (7), extended trigger for `execution.state`, `result_ref` extended for `minio`/`pvc`.

### Phase 2 — Storage

MinIO Helm chart for kind, `StoreTier.MINIO`/`PVC` in Python + `result_store.py`, PVC Kubernetes volume config, DuckDB direct Parquet reads.

### Phase 3 — Distributed Fan-out

Implement `spec.loop_mode: fanout`: server splits collection → N shard commands → fan-in tracking via event table → `loop.fanin.completed` → route `next.arcs` with `fanin.*` variables. Shard-level retry with `max_shard_retries`.

### Phase 4 — NATS Transport

Server-side NATS consumer for worker events. Worker `NOETL_EVENT_TRANSPORT=nats` opt-in. Worker capacity heartbeat → `runtime.capacity` update → in-memory capacity registry. Targeted dispatch to `noetl.commands.{worker_id}`.

### Phase 5 — Observability

`GET /api/executions/{id}` from `noetl.execution` projection (no event scan). `call.partial` event type for streaming chunk results. `noetl status --json` loop progress output.

### Dependency graph

```
P0.1 + P0.2 + P0.3 ──→ P1.1 (indexes) ──→ P1.2 (trigger) ──→ P5.1 (status API)
                                                              ──→ P3.1 (fan-out)
P0.4 (reaper)                                                        │
P1.3 (store_tier) ──→ P2.1 (MinIO) ──→ P2.2 (backend)            ├──→ P3.2 (fan-in)
                   ──→ P2.3 (PVC)                                  └──→ P3.3 (retry)
P4.1 (NATS) ──→ P4.2 (capacity) ──→ P4.3 (targeted dispatch)
P5.2 (call.partial) — independent
```

---

## 9. Outputs of This Session

### Documents committed to `noetl/docs` (commit `047fe41`)

| File | Purpose |
|---|---|
| `docs/features/noetl_distributed_processing_plan.md` | Master plan: phases, tasks, acceptance criteria, test fixtures, dependency graph |
| `docs/features/noetl_schema_enhancements.md` | Complete DDL: indexes, trigger, event type field specs, `execution.state` schema |
| `docs/features/noetl_worker_communication.md` | Architecture analysis: NATS transport decision, NATS stream config, migration plan |

### Memory committed to `noetl/ai-meta`

- `memory/inbox/2026/04/20260414-170403-noetl-distributed-processing-enhancement-plan.md`

### Issues / PRs referenced

- `noetl/noetl#345` — asyncio blocking / over-dispatch (merged as v2.13.1)
- `noetl/noetl#352` — loop replay fix + tooling matrix
- `noetl/noetl#261..#265` — patient-loss race conditions (AHM-4280..4284), targeted by `test_pft_flow`
- Execution `604876797720658689` — `test_pft_flow` run at session start

---

## 10. Open Items After This Session

- Run `test_pft_flow` to GO/NO-GO on `#261..#265` (execution `604876797720658689`)
- Start implementation branch for P0.1 (unique index + catch) — smallest, highest impact
- Start implementation branch for P0.2 (atomic `loop.done`) — directly fixes `test_pft_flow` patient loss
- Decide: implement P0.3 and P0.4 in same PR as P0.1/P0.2 or separate PRs
- Review `noetl_distributed_processing_plan.md` with team before starting P1
- Provision MinIO in kind cluster (P2.1) — unblocks local development without GCS credentials
