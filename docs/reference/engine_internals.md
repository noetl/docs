---
sidebar_position: 18
title: NoETL Engine Internals
description: Internal execution model for the NoETL playbook engine, including state reloads, loop handling, reference-based data flow, and storage tier guidance.
---

# NoETL Engine Internals

## 1. The Event-Command Loop

The engine is event-driven, not call-stack-driven.

```text
Event arrives -> engine evaluates -> emits Command(s) -> worker picks up ->
worker emits result Event -> engine evaluates again -> ...
```

Each `handle_event()` call is stateless at the call level:
- reload `ExecutionState` from Postgres
- process one event
- write new events and commands
- save state back

There is no persistent in-memory stack frame holding execution progress.

State persistence:
- `ExecutionState.to_dict()` is serialized into `noetl.execution.state`
- every event handler call effectively does `load_state -> process -> save_state`

## 2. ExecutionState

`ExecutionState` (`noetl/core/dsl/engine/executor/state.py`) is the in-memory object for one execution.

| Field | Type | Purpose |
|---|---|---|
| `variables` | `dict` | Execution-scoped workload vars and `set:` mutations |
| `step_results` | `dict[step_name -> compact_envelope]` | Compact references and scalar context |
| `completed_steps` | `set[str]` | Idempotency guard |
| `issued_steps` | `set[str]` | Pending issued-but-not-completed steps |
| `loop_state` | `dict[step -> loop_meta]` | Loop index, epoch, counters per step |
| `emitted_loop_epochs` | `set[str]` | In-call dedup for `loop.done` |
| `pagination_state` | `dict` | collect+retry cursor state |
| `pending_next_actions` | `dict` | Deferred `next:` for inline task blocks |

Critical invariant:
- `step_results` stores compact envelopes only
- the control plane carries references plus bounded scalar context
- large row payloads belong in external storage, not in state JSON

## 3. Where Actual Data Lives

When a worker produces a large result, the runtime externalizes it and the engine carries only a reference envelope:

```text
noetl://execution/<eid>/result/<step>/<uuid>
```

### Storage tiers

| Tier | Backend | Recommended payload size | Purpose |
|---|---|---|---|
| `memory` | In-process cache | tiny | Local previews and very small values |
| `kv` | NATS KV | up to about 1 MB | Fast execution-scoped scalars and small JSON |
| `minio` | MinIO / S3-compatible object storage | above 1 MB | Preferred backend for medium and large execution data |
| `pvc` | PVC / mounted volume | very large files | Local large-file exchange and DuckDB-readable artifacts |
| `s3` / `gcs` | Cloud object storage | large and durable | Cross-system durable artifacts |
| `db` | PostgreSQL | queryable | Relational intermediate tables and projections |

### RisingWave-aligned tiers (phase 0 onward)

For execution payloads larger than about 1 MB, the router selects
`StoreTier.DISK` — a local SSD/NVMe cache per worker with async spill
to the configured cloud tier (S3/MinIO or GCS via
`NOETL_STORAGE_CLOUD_TIER`). This mirrors
[RisingWave's disk cache architecture](https://docs.risingwave.com/get-started/disk-cache).

Why:
- NATS KV is appropriate for small control-plane state, not multi-MB result transport.
- The NATS Object Store tier was removed in the phase 0 RisingWave
  alignment. `store: "object"` payloads are auto-remapped to
  `store: "disk"` with a one-time deprecation warning.
- The DISK tier gives every worker a local hot cache + durable cloud
  spill, which matches the elasticity and warm-start story in RisingWave.
- In phase 0 the DISK backend itself is a placeholder; writes fall
  through directly to the configured cloud tier. Phase 1 adds the
  two-pool local cache (meta + data) with rate-limited inserts and
  `recover_mode=Quiet` warm start.

See [Storage and Streaming Alignment with RisingWave](../features/noetl_storage_and_streaming_alignment.md).

### Interim data placement

| Data | Location |
|---|---|
| Small scalars | `state.variables` or compact `step_results.context` |
| Small SQL row sets | NATS KV |
| Medium and large row sets / payloads | MinIO |
| Large files | MinIO, PVC, or cloud object storage |
| Loop collections | reference-backed storage; prefer MinIO once collections exceed KV-friendly size |
| Execution lineage and metadata | Postgres `noetl.event` and `noetl.execution` |

## 4. Context Variables and Template Access

Jinja2 templates get a render context assembled by `get_render_context()`:

```python
context = {
    "ctx": state.variables,
    "iter": iter_vars,
    "workload": state.variables,
    "loop": {index, first, length, done},
    "output": output_view,
    "execution_id": "...",
    "job": {...},
    "claim_patients": <compact_envelope>,
    "load_patients": <compact_envelope>,
}
```

When a template uses `{{ claim_patients.rows }}`, the step result is a compact envelope with:
- promoted scalar fields such as `row_count`, `status`, and previews
- a `reference` object pointing to external storage

Hydration happens on demand when the template needs the actual rows.

| Template expression | Resolves from |
|---|---|
| `{{ ctx.facility_id }}` | execution scope |
| `{{ iter.facility }}` | current loop item |
| `{{ _index }}` | current loop index |
| `{{ output.status }}` | current event result envelope |
| `{{ output.data.rows }}` | resolved result if needed |
| `{{ claim_patients.row_count }}` | compact scalar field |
| `{{ claim_patients.rows }}` | hydrated via reference resolution |

## 5. Loop Mechanics

When a step with `loop:` is entered:

```text
1. Render loop.in_ template -> get collection
2. If result is a reference envelope -> resolve from storage
3. Save loop collection under the current epoch
4. state.init_loop(...)
5. Emit one command per item (parallel) or one at a time (sequential)
```

Each loop invocation gets a unique epoch key:

```text
loop_<execution_id>_<microsecond_timestamp>
```

That epoch is used for:
- command metadata
- loop collection persistence
- `loop.done` dedup via DB uniqueness

Completion tracking uses:
1. fast runtime or supervisor counters
2. Postgres event-log fallback

Typical fallback query pattern:

```sql
COUNT(DISTINCT meta->>'loop_iteration_index')
WHERE event_type = 'call.done'
  AND meta->>'loop_event_id' = <epoch>
```

## 6. State Pruning

After each `loop.done`, `prune_stale_state()` bounds execution-state growth:
- evict stale `step_results`
- prune mirrored variables
- cap `emitted_loop_epochs`

Without pruning, long-running executions turn state JSON growth into a throughput bottleneck.

## 7. `task_sequence`

For multi-task `then:` blocks, the engine can emit one synthetic `task_sequence` command. The worker runs sub-tasks atomically inside one message instead of paying queue round-trips per sub-task.

Pending-step tracking strips the synthetic `:task_sequence` suffix so it does not block terminal lifecycle emission.

## 8. Arc Evaluation

After a step completes, `next:` arcs are evaluated via Jinja2 `when:` conditions.

| Mode | Behavior |
|---|---|
| `exclusive` | First matching arc wins |
| `all` | All matching arcs fire |

Available during evaluation:
- `output.status`
- `output.data`
- `ctx.*`
- completed step envelopes

## 9. Event Types Reference

| Event type | Emitted by | Meaning |
|---|---|---|
| `playbook.initialized` | server | Execution started |
| `workflow.initialized` | server | Workflow layer started |
| `command.issued` | server | Command written to queue |
| `command.claimed` | worker | Worker picked up command |
| `command.started` | worker | Worker began processing |
| `command.completed` | worker | Tool execution succeeded |
| `command.failed` | worker | Tool execution failed after retries |
| `step.enter` | worker | Step processing started |
| `step.exit` | worker | Step processing finished |
| `call.done` | server | Step call resolved |
| `call.error` | server | Step call resolved with error |
| `loop.done` | server | All loop iterations complete for one epoch |
| `batch.accepted` | server | Event batch received |
| `batch.processing` | server | Event batch being processed |
| `batch.completed` | server | Event batch committed |
| `batch.failed` | server | Event batch failed |
| `playbook.completed` | server | Terminal success |
| `playbook.failed` | server | Terminal failure |
| `execution.cancelled` | server | Terminal cancellation |

## 10. Storage Guidance — RisingWave-Aligned Tiers

Recommended policy:
- keep NATS KV for small execution-scoped control-plane state (< 1 MB)
- route payloads above 1 MB to `StoreTier.DISK` (local SSD cache + async
  cloud spill); in phase 0 this spills directly to the cloud tier
  selected by `NOETL_STORAGE_CLOUD_TIER` (S3/MinIO or GCS)
- use PVC mounts for the disk cache directory
  (`NOETL_STORAGE_LOCAL_CACHE_DIR`) — phase 1
- treat the NATS Object Store tier as removed; envelopes with
  `store: "object"` are auto-remapped to `store: "disk"` with a
  one-time deprecation warning

That keeps the control plane light, reduces NATS pressure from multi-MB
objects, and matches RisingWave's three-tier hot/warm/cold model for
local-to-cloud storage.
