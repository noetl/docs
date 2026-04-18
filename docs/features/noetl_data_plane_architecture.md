---
sidebar_position: 45
title: NoETL Data Plane Architecture
description: Reference architecture for the data/control plane separation in NoETL — how result data flows through persistent storage instead of event context.
---

# NoETL Data Plane Architecture

## 1. Overview

NoETL separates **control plane** (orchestration, routing, epoch barriers) from **data plane** (result payloads, loop collections, intermediate state). This document describes the production architecture after the April 2026 redesign, covering how data flows through the system, where it's stored, and how downstream consumers access it.

## 2. Core Principle

> Data flows through persistent storage. The control plane carries only references and scalar metadata.

Inspired by [RisingWave's streaming architecture](https://docs.risingwave.com/get-started/architecture) where operators exchange epoch-versioned references to shared state (Hummock / S3), not inline data. NoETL applies the same pattern to orchestration: tools persist results to TempStore, events carry compact `{status, reference, context}` envelopes, and downstream steps resolve references on demand.

## 3. Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE                                │
│                                                                  │
│  Server (FastAPI)                                                │
│  ├─ handle_event() → evaluate next.arcs → issue commands         │
│  ├─ ProjectionWorker (async, per shard)                          │
│  ├─ Checkpointer (1-sec epoch barriers)                          │
│  ├─ ShardManager (lease-based ownership)                         │
│  └─ Reaper (expired claims)                                      │
│                                                                  │
│  Events carry:                                                   │
│    {status, reference: {kind, ref, store}, context: {scalars}}   │
│  Events do NOT carry: rows, columns, payloads, large dicts       │
├─────────────────────────────────────────────────────────────────┤
│                      DATA PLANE                                  │
│                                                                  │
│  TempStore (noetl.core.storage.result_store)                     │
│  ├─ NATS KV    (<1MB, execution-scoped, fast)                    │
│  ├─ NATS Object (<10MB, execution-scoped)                        │
│  ├─ MinIO/S3   (>10MB, durable, cross-worker)                    │
│  ├─ PVC        (large files, DuckDB-readable)                    │
│  └─ Postgres   (queryable, relational)                           │
│                                                                  │
│  Loop collections stored in NATS KV:                             │
│    save_loop_collection(exec_id, step, epoch_id, rows)           │
│    get_loop_collection(exec_id, step, epoch_id) → rows           │
├─────────────────────────────────────────────────────────────────┤
│                   WORKER (stateless)                              │
│                                                                  │
│  Tool execution → result data                                    │
│  ├─ Postgres tool: persist rows to TempStore                     │
│  ├─ HTTP tool: persist response to TempStore (if large)          │
│  └─ Emit event: {status, reference, context} only                │
│                                                                  │
│  _extract_control_context blocks: rows, columns, data, payload   │
│  _extract_control_context passes: reference dicts, scalars       │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Data Flow: Postgres Tool

### Before (inline)

```
Postgres SELECT → {rows: [{...}, ...], row_count: 100, columns: [...]}
    ↓
event.result = {status: "ok", data: {rows: [...], row_count: 100}}
    ↓
context variable: {{ claim_patients.rows }} → inline array
    ↓
loop.in consumes rows directly from context
```

**Problems:** Event bloat (100KB+ per event), cold-state rebuild failure (rows not in event after context extraction strips them), pool exhaustion from large payloads, synthetic collection races.

### After (reference-based)

```
Postgres SELECT → result_data = [{...}, ...]
    ↓
_externalize_rows_to_store(result_data, execution_id, step_name)
    ↓
TempStore.put(rows) → TempRef {kind: "temp_ref", ref: "noetl://exec/.../rows", store: "kv"}
    ↓
event.result = {status: "ok", reference: {kind, ref, store}, context: {row_count: 100, columns: [...]}}
    ↓
mark_step_completed: eagerly resolves reference → caches rows in step_results
    ↓
{{ claim_patients.rows }} → resolved from step_results (real patient dicts)
    ↓
loop.in: _resolve_collection_if_reference() → TempStore.resolve() → real rows
    ↓
save_loop_collection(rows) → NATS KV for cold-state recovery
```

## 5. Key Components

### 5.1 Postgres Tool Externalization

**File:** `noetl/tools/postgres/executor.py`

```python
async def _externalize_rows_to_store(result, *, execution_id, step_name):
    """Persist SELECT rows to TempStore. Return reference envelope."""
    rows = result.get("rows")
    if not rows or not execution_id:
        return result  # fallback: keep inline
    temp_ref = await default_store.put(
        execution_id=str(execution_id),
        name=f"{step_name}/rows",
        data=rows,
        scope=Scope.EXECUTION,
    )
    return {
        "status": result["status"],
        "reference": {"kind": "temp_ref", "ref": temp_ref.ref, "store": ...},
        "context": {"row_count": len(rows), "columns": result.get("columns")},
    }
```

Called after `collapse_results_to_last_command()` in the executor. Falls back to inline if TempStore is unavailable (backward compat for local/test).

### 5.2 Loop Collection Resolver

**File:** `noetl/core/dsl/engine/executor/common.py`

```python
async def _resolve_collection_if_reference(value):
    """If value is a reference envelope, resolve to actual data."""
    if not isinstance(value, dict):
        return value
    ref = value.get("reference")
    if isinstance(ref, dict):
        resolved = await default_store.resolve(ref)
        if isinstance(resolved, list):
            return resolved
    return value
```

Called in three places after rendering `loop.in` templates:
1. `transitions.py` — at dispatch time (fresh loop entry)
2. `rendering.py` — in `_ensure_loop_state_for_epoch` (cold-state hydration)
3. `commands.py` — in the fallback re-render path

### 5.3 Eager Reference Resolution

**File:** `noetl/core/dsl/engine/executor/state.py`

`mark_step_completed` is **async**. When a result carries `reference.kind = "temp_ref"`:

1. Resolve via `default_store.resolve(ref)` → actual rows list
2. Cache as `result["rows"] = resolved` in `step_results`
3. Promote context keys to top level (`row_count`, `columns`)

Templates like `{{ claim_patients.rows }}` work without playbook changes — the rows are in `step_results` at render time.

### 5.4 Context Extraction

**File:** `noetl/worker/nats_worker.py`

`_extract_control_context` blocked keys:

| Key | Status | Reason |
|---|---|---|
| `rows` | **Blocked** | Data plane — persisted to TempStore |
| `columns` | **Blocked** | Data plane — persisted alongside rows |
| `data`, `response`, `result`, `payload` | **Blocked** | Legacy inline transport shapes |
| `reference` (dict with `kind`) | **Passed through** | Control plane metadata |
| Scalars (status, row_count, etc.) | **Passed through** | Control plane routing |

### 5.5 Loop Collection Persistence

**Files:** `transitions.py`, `commands.py`

Real collections saved to NATS KV at three points:
1. `transitions.py` — after rendering, before dispatch (all loop steps)
2. `commands.py:226` — first-entry path
3. `commands.py:~375` — epoch reset path

Cold-state recovery in `rendering.py._ensure_loop_state_for_epoch`:
1. Try in-memory `existing_state.collection`
2. Try re-render template `{{ claim_patients.rows }}`
3. Try `nats_cache.get_loop_collection(exec_id, step, epoch_id)` ← **real data**
4. Last resort: synthetic `list(range(collection_size))` ← **accounting only**

### 5.6 Resolved Row List Wrapping

**File:** `noetl/core/dsl/engine/executor/common.py`

When `_merge_hydrated_step_result` resolves a reference to a raw list, it wraps it in a canonical data-view dict:

```python
{"rows": resolved_list, "row_count": len(resolved_list), "columns": columns}
```

This matches the shape of inline Postgres results so `{{ output.data.row_count }}` works in routing conditions.

## 6. Connection Pool Architecture

Two separate pools prevent background-task starvation during peak dispatch:

| Pool | Size | Purpose |
|---|---|---|
| **Main pool** | min=2, max=32 | Command dispatch, event handling, state queries |
| **Background pool** | min=1, max=4 | Checkpointer, ProjectionWorker, ShardManager, `get_snowflake_id()` |

**File:** `noetl/core/db/pool.py`

`get_pool_connection()` → main pool (command dispatch)
`get_bg_pool_connection()` → background pool (never starved by dispatch bursts)
`get_snowflake_id()` → background pool

## 7. Distributed Loop Execution Model

### Epoch Management

Each loop activation gets a deterministic epoch ID:

```
loop_{execution_id}_{step_name}_{attempt}
```

Where `attempt = COUNT(loop.done events for this step) + 1` from the DB. This ensures unique epoch IDs across re-entries — the `uidx_event_loop_done_loop_id` partial unique index prevents duplicate `loop.done` events.

### NATS KV Loop State

```
Key: {exec_id}.loop:{step}:{epoch_id}
Value: {
    collection_size: 100,
    completed_count: 0,
    scheduled_count: 0,
    iterator: "patient",
    mode: "parallel",
    event_id: "loop_..._1"
}
```

`set_loop_state` with `force_replace=True` on epoch reset — prevents the merge path from clamping `completed_count` to the prior epoch's value.

### Deduplication Guards

| Guard | Mechanism | Purpose |
|---|---|---|
| `command.issued` | `uidx_event_command_issued_command_id` | Prevent duplicate dispatch |
| `loop.done` | `uidx_event_loop_done_loop_id` | Prevent duplicate completion |
| `loop.fanin.completed` | `uidx_event_loop_fanin_completed` | Prevent duplicate fan-in |
| Re-entrant step | DB authority check on `command.completed` count | Allow re-dispatch when `completed_steps` stale from async batch acceptance |

## 8. Invariants

1. **Events are compact.** `event.result` carries `{status, reference, context}` — never inline row data for Postgres SELECT results.
2. **Data lives in TempStore.** Rows are persisted before the event is emitted. The reference is durable for the execution's lifetime.
3. **Loop collections are in NATS KV.** Saved at dispatch time with the real data (patient rows). Cold-state recovery restores from NATS KV before falling back to synthetic placeholders.
4. **Templates work unchanged.** `{{ step.rows }}` resolves transparently via eager resolution in `mark_step_completed`. No playbook DSL changes.
5. **Background tasks are never starved.** Dedicated pool (max=4) ensures checkpointer, projection worker, and snowflake ID generation always have connections.
6. **Epoch IDs are unique per re-entry.** DB-derived attempt counter prevents `loop.done` deduplication on natural loop restarts.

## 9. Configuration

| Env var | Default | Description |
|---|---|---|
| `NOETL_POSTGRES_POOL_MAX_SIZE` | 32 | Main connection pool max |
| `NOETL_BG_POOL_MAX_SIZE` | 4 | Background pool max |
| `NOETL_SHARD_COUNT` | 16 (2 for dev) | Execution shards for projection/checkpoint |
| `NOETL_CHECKPOINT_INTERVAL_MS` | 1000 (5000 for dev) | Epoch barrier cadence |
| `NOETL_EVENT_RESULT_CONTEXT_MAX_BYTES` | 10485760 | Max context size before truncation |

## 10. Related Documents

| Document | Role |
|---|---|
| [Async/Sharded Architecture](./noetl_async_sharded_architecture.md) | Parent architecture spec (trigger removal, sharding, epochs) |
| [Reference-Only Event Results PRD](./reference-only-event-results-prd.md) | PRD that mandated this data plane separation |
| [Worker Communication](./noetl_worker_communication.md) | NATS/HTTP transport split |
| [Distributed Processing Plan](./noetl_distributed_processing_plan.md) | Original 5-phase plan (Phase 1 trigger material superseded) |
| [Schema Enhancements](./noetl_schema_enhancements.md) | DDL reference for indexes and event types |
