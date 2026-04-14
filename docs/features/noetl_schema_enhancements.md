---
sidebar_position: 41
title: NoETL Schema Enhancements — DDL Reference
description: Complete DDL for event table indexes, projection table extensions, and new loop/fanout event types supporting the distributed processing enhancement plan.
---

# NoETL Schema Enhancements — DDL Reference

This document is the authoritative DDL reference for Phase 1 of the distributed processing enhancement plan. All changes are **additive and idempotent** (`IF NOT EXISTS`, `DO NOTHING`, `ADD COLUMN IF NOT EXISTS`). No existing columns, tables, or indexes are removed.

---

## Design Principles

- **`noetl.event` is append-only.** New event types are added; existing rows are never modified.
- **`noetl.execution` is a projection table.** It is always reconstructable by replaying all `noetl.event` rows through the trigger. It must never be used as the primary write target.
- **Unique indexes enforce at-most-once semantics** for commands and loop-done events. The application catches `UniqueViolationError` and treats it as a signal to skip, not as an error.
- **`execution.state` JSONB accumulates incrementally.** The trigger performs `jsonb_set(state, path, value)` rather than full replacement, so concurrent updates to different paths are safe.

---

## 1. New Unique Indexes on `noetl.event`

### 1.1 Atomic `command.issued` deduplication

Prevents two concurrent coroutines from issuing duplicate commands for the same step attempt.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_command_issued_command_id
    ON noetl.event (execution_id, (meta->>'command_id'))
    WHERE event_type = 'command.issued' AND meta ? 'command_id';
```

**Application contract:** `handle_event()` must catch `asyncpg.UniqueViolationError` on the `command.issued` INSERT and return an empty command list without publishing to NATS.

### 1.2 Atomic `loop.done` claim per `loop_id`

Ensures exactly one `loop.done` event is emitted per loop epoch, regardless of concurrent `call.done` processors.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_loop_done_loop_id
    ON noetl.event (execution_id, (meta->>'loop_id'))
    WHERE event_type = 'loop.done' AND meta ? 'loop_id';
```

**Application contract:** Insert `loop.done` with `ON CONFLICT DO NOTHING RETURNING event_id`. Only the coroutine that receives a non-null `event_id` from `RETURNING` proceeds to evaluate `next.arcs`.

### 1.3 Atomic `loop.fanin.completed` claim per `loop_id`

Ensures exactly one `loop.fanin.completed` event is emitted per distributed fan-out epoch.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_loop_fanin_completed_loop_id
    ON noetl.event (execution_id, (meta->>'loop_id'))
    WHERE event_type = 'loop.fanin.completed' AND meta ? 'loop_id';
```

---

## 2. New Query-Support Indexes on `noetl.event`

### 2.1 Fan-in and loop progress counting by `loop_id`

Used by the fan-in count query and loop progress reconstruction.

```sql
CREATE INDEX IF NOT EXISTS idx_event_loop_id_type
    ON noetl.event (execution_id, (meta->>'loop_id'), event_type)
    WHERE meta ? 'loop_id';
```

**Query it supports:**

```sql
SELECT
    (meta->>'total_shards')::int                                             AS total_shards,
    COUNT(*) FILTER (WHERE event_type = 'loop.shard.done')                  AS done,
    COUNT(*) FILTER (WHERE event_type = 'loop.shard.failed')                AS failed
FROM noetl.event
WHERE execution_id = $1
  AND node_name    = $2
  AND meta->>'loop_id' = $3
  AND event_type IN ('loop.fanout.started', 'loop.shard.done', 'loop.shard.failed')
GROUP BY 1;
```

### 2.2 Loop recovery query by `loop_id`

Used for server-restart loop state reconstruction from the event table.

```sql
-- Covered by idx_event_loop_id_type; no additional index needed.
-- Recovery query:
SELECT
    COALESCE(MAX(current_index), -1)                                         AS current_index,
    COUNT(*) FILTER (WHERE event_type = 'command.completed')                 AS done_count,
    COUNT(*) FILTER (WHERE event_type = 'command.failed')                    AS failed_count,
    MAX(CASE WHEN event_type = 'loop.started'
             THEN context->>'collection_ref' END)                             AS collection_ref,
    MAX(CASE WHEN event_type = 'loop.started'
             THEN (meta->>'collection_size')::int END)                        AS collection_size
FROM noetl.event
WHERE execution_id = $1
  AND node_name    = $2
  AND meta->>'loop_id' = $3;
```

---

## 3. New Loop Event Types — Field Specification

All new event types use existing columns; no new columns are added to `noetl.event`.

### 3.1 `loop.started`

Written by the server when a loop step is first entered and the collection is materialized.

| Column | Value |
|---|---|
| `event_type` | `'loop.started'` |
| `node_name` | step name |
| `node_type` | `'loop'` |
| `meta` | `{"loop_id": "<snowflake_id>", "collection_size": N, "mode": "sequential"|"parallel"|"fanout"}` |
| `context` | `{"collection_ref": "<MinIO/GCS/S3 URI>"}` — only when collection is externalized (size > threshold) |
| `current_index` | `0` |
| `status` | `'started'` |

`loop_id` is a new snowflake ID generated by the server at loop initialization. It uniquely identifies one activation of a loop step within an execution. If the step is re-entered (loop back), a new `loop_id` is generated.

### 3.2 `loop.item`

Written by the server each time it issues a loop iteration command. Already partially implemented via `current_index` and `current_item` columns.

| Column | Value |
|---|---|
| `event_type` | `'loop.item'` |
| `node_name` | step name |
| `meta` | `{"loop_id": "<id>", "iter_index": N}` |
| `current_index` | N (the 0-based iteration index) |
| `current_item` | JSON-serialized iteration element (if small; else omit) |
| `status` | `'dispatched'` |

### 3.3 `loop.done`

Written atomically (via `ON CONFLICT DO NOTHING`) when all iterations complete.

| Column | Value |
|---|---|
| `event_type` | `'loop.done'` |
| `node_name` | step name |
| `meta` | `{"loop_id": "<id>"}` |
| `result` | `{"status": "ok", "context": {"total": N, "completed": M, "failed": F}}` |
| `status` | `'completed'` |

### 3.4 `loop.fanout.started`

Written by the server when `spec.loop_mode: fanout` is activated, before shard commands are issued.

| Column | Value |
|---|---|
| `event_type` | `'loop.fanout.started'` |
| `node_name` | step name |
| `meta` | `{"loop_id": "<id>", "total_shards": N}` |
| `context` | `{"shards_ref": "<URI to shard manifest>"}` — optional |
| `current_index` | `0` |
| `status` | `'started'` |

### 3.5 `loop.shard.enqueued`

Written by the server once per shard when issuing shard commands.

| Column | Value |
|---|---|
| `event_type` | `'loop.shard.enqueued'` |
| `node_name` | step name |
| `meta` | `{"loop_id": "<id>", "shard_id": "<uuid>", "iter_index": N, "iter_key": "<optional>"}` |
| `current_index` | N |

### 3.6 `loop.shard.done` / `loop.shard.failed`

Written by the worker (or server reaper) when a shard command terminates.

| Column | `loop.shard.done` | `loop.shard.failed` |
|---|---|---|
| `event_type` | `'loop.shard.done'` | `'loop.shard.failed'` |
| `node_name` | step name | step name |
| `meta` | `{"loop_id", "shard_id", "command_id"}` | `{"loop_id", "shard_id", "command_id"}` |
| `result` | `{"status": "ok", ...}` | `{"status": "error", ...}` |
| `error` | `NULL` | error message |

### 3.7 `loop.fanin.completed`

Written atomically (via `ON CONFLICT DO NOTHING`) when done + failed = total_shards.

| Column | Value |
|---|---|
| `event_type` | `'loop.fanin.completed'` |
| `node_name` | step name |
| `meta` | `{"loop_id": "<id>"}` |
| `result` | `{"status": "complete"|"failed"|"partial", "context": {"done": M, "failed": F, "total": N}}` |
| `status` | `'completed'` or `'partial'` or `'failed'` |

---

## 4. `noetl.execution.state` Schema

The `state` JSONB column (already added) accumulates structured data via the trigger.

```json
{
  "loop": {
    "{step_name}": {
      "loop_id":        "604876797720658689",
      "total":          1000,
      "done":           456,
      "failed":         2,
      "collection_ref": "s3://noetl-results/exec/604876.../loop/step_name/collection.json",
      "mode":           "parallel",
      "completed":      false
    }
  },
  "fanout": {
    "{step_name}": {
      "loop_id":       "604876797720658691",
      "total_shards":  20,
      "done":          18,
      "failed":        1,
      "status":        "running"
    }
  }
}
```

**Trigger update logic for loop events:**

```sql
-- loop.started → initialize entry
state = jsonb_set(
    COALESCE(state, '{}'),
    ARRAY['loop', node_name],
    jsonb_build_object(
        'loop_id',        meta->>'loop_id',
        'total',          (meta->>'collection_size')::int,
        'done',           0,
        'failed',         0,
        'collection_ref', context->>'collection_ref',
        'mode',           meta->>'mode',
        'completed',      false
    ),
    true
)

-- loop.done → mark completed
state = jsonb_set(
    state,
    ARRAY['loop', node_name, 'completed'],
    'true'::jsonb
)

-- loop.shard.done → increment done counter atomically
state = jsonb_set(
    state,
    ARRAY['fanout', node_name, 'done'],
    to_jsonb(
        COALESCE((state->'fanout'->node_name->>'done')::int, 0) + 1
    )
)

-- loop.shard.failed → increment failed counter atomically
state = jsonb_set(
    state,
    ARRAY['fanout', node_name, 'failed'],
    to_jsonb(
        COALESCE((state->'fanout'->node_name->>'failed')::int, 0) + 1
    )
)
```

**Important:** The trigger UPSERT uses `ON CONFLICT (execution_id) DO UPDATE SET state = ...`. For concurrent shard events hitting the same `execution_id` row, PostgreSQL row-level locking on the `execution` row serializes the updates. This is safe but creates a hot row under high fan-out concurrency. Mitigation: batch shard events in groups before updating (Phase 4 NATS batching).

---

## 5. `result_ref.store_tier` Constraint Update

```sql
ALTER TABLE noetl.result_ref
    DROP CONSTRAINT IF EXISTS result_ref_store_tier_check;

ALTER TABLE noetl.result_ref
    ADD CONSTRAINT result_ref_store_tier_check
    CHECK (store_tier IN (
        'memory', 'kv', 'object', 's3', 'gcs', 'db', 'duckdb', 'eventlog', 'minio', 'pvc'
    ));

COMMENT ON COLUMN noetl.result_ref.store_tier IS
    'Storage backend: memory, kv (NATS KV), object (NATS Object), s3 (Amazon S3), '
    'gcs (Google Cloud Storage), db (PostgreSQL), duckdb (local DuckDB), '
    'eventlog (inline in event), minio (MinIO S3-compatible), pvc (k8s PVC or FUSE mount)';

COMMENT ON COLUMN noetl.result_ref.physical_uri IS
    'Actual storage location: s3://bucket/key, gs://bucket/key, '
    'kv://bucket/key, or /data/exec/{eid}/step/name.parquet (pvc mount path)';
```

---

## 6. Extended Trigger — Full Replacement

```sql
CREATE OR REPLACE FUNCTION noetl.trg_execution_state_upsert()
RETURNS TRIGGER AS $$
DECLARE
    new_status  VARCHAR;
    is_terminal BOOLEAN := FALSE;
    loop_step   TEXT;
    loop_id     TEXT;
BEGIN
    -- ----------------------------------------------------------------
    -- LOOP / FANOUT EVENTS: update execution.state only, no status change
    -- ----------------------------------------------------------------
    IF NEW.event_type IN (
        'loop.started', 'loop.item', 'loop.done',
        'loop.fanout.started', 'loop.shard.enqueued',
        'loop.shard.done', 'loop.shard.failed',
        'loop.fanin.completed'
    ) THEN
        loop_step := NEW.node_name;
        loop_id   := NEW.meta->>'loop_id';

        IF loop_step IS NOT NULL AND loop_id IS NOT NULL THEN
            INSERT INTO noetl.execution (
                execution_id, catalog_id, status, created_at, updated_at, state
            )
            VALUES (
                NEW.execution_id, NEW.catalog_id, 'RUNNING',
                NEW.created_at, NEW.created_at, '{}'::jsonb
            )
            ON CONFLICT (execution_id) DO UPDATE SET
                updated_at = EXCLUDED.updated_at,
                state = CASE NEW.event_type

                    WHEN 'loop.started' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['loop', loop_step],
                            jsonb_build_object(
                                'loop_id',        loop_id,
                                'total',          (NEW.meta->>'collection_size')::int,
                                'done',           0,
                                'failed',         0,
                                'collection_ref', NEW.context->>'collection_ref',
                                'mode',           COALESCE(NEW.meta->>'mode', 'sequential'),
                                'completed',      false
                            ),
                            true
                        )

                    WHEN 'loop.done' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['loop', loop_step, 'completed'],
                            'true'::jsonb
                        )

                    WHEN 'loop.fanout.started' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['fanout', loop_step],
                            jsonb_build_object(
                                'loop_id',      loop_id,
                                'total_shards', (NEW.meta->>'total_shards')::int,
                                'done',         0,
                                'failed',       0,
                                'status',       'running'
                            ),
                            true
                        )

                    WHEN 'loop.shard.done' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['fanout', loop_step, 'done'],
                            to_jsonb(
                                COALESCE(
                                    (noetl.execution.state->'fanout'->loop_step->>'done')::int,
                                    0
                                ) + 1
                            )
                        )

                    WHEN 'loop.shard.failed' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['fanout', loop_step, 'failed'],
                            to_jsonb(
                                COALESCE(
                                    (noetl.execution.state->'fanout'->loop_step->>'failed')::int,
                                    0
                                ) + 1
                            )
                        )

                    WHEN 'loop.fanin.completed' THEN
                        jsonb_set(
                            COALESCE(noetl.execution.state, '{}'),
                            ARRAY['fanout', loop_step, 'status'],
                            to_jsonb(COALESCE(NEW.result->>'status', 'completed'))
                        )

                    ELSE noetl.execution.state
                END;
        END IF;
        RETURN NEW;
    END IF;

    -- ----------------------------------------------------------------
    -- HIGH-FREQUENCY NON-ROUTING EVENTS: skip entirely
    -- ----------------------------------------------------------------
    IF NOT (NEW.event_type IN (
        'playbook.initialized', 'playbook.completed', 'playbook.failed',
        'workflow.initialized', 'workflow.completed', 'workflow.failed',
        'execution.cancelled', 'step.enter', 'step.exit', 'command.failed'
    )) THEN
        RETURN NEW;
    END IF;

    -- ----------------------------------------------------------------
    -- LIFECYCLE EVENTS: update execution status
    -- ----------------------------------------------------------------
    IF NEW.event_type IN ('playbook.completed', 'workflow.completed') THEN
        new_status := 'COMPLETED'; is_terminal := TRUE;
    ELSIF NEW.event_type IN ('playbook.failed', 'workflow.failed', 'command.failed') THEN
        new_status := 'FAILED'; is_terminal := TRUE;
    ELSIF NEW.event_type = 'execution.cancelled' THEN
        new_status := 'CANCELLED'; is_terminal := TRUE;
    ELSE
        new_status := 'RUNNING';
    END IF;

    INSERT INTO noetl.execution (
        execution_id, catalog_id, parent_execution_id, status,
        last_event_type, last_node_name, last_event_id,
        start_time, end_time, error, created_at, updated_at
    )
    VALUES (
        NEW.execution_id, NEW.catalog_id, NEW.parent_execution_id, new_status,
        NEW.event_type, NEW.node_name, NEW.event_id,
        CASE WHEN NEW.event_type IN ('playbook.initialized','workflow.initialized')
             THEN NEW.created_at ELSE NULL END,
        CASE WHEN is_terminal THEN NEW.created_at ELSE NULL END,
        NEW.error, NEW.created_at, NEW.created_at
    )
    ON CONFLICT (execution_id) DO UPDATE SET
        catalog_id          = EXCLUDED.catalog_id,
        parent_execution_id = COALESCE(EXCLUDED.parent_execution_id,
                                       noetl.execution.parent_execution_id),
        status = CASE
            WHEN noetl.execution.status IN ('COMPLETED','FAILED','CANCELLED')
            THEN noetl.execution.status
            ELSE EXCLUDED.status
        END,
        last_event_type = CASE
            WHEN NEW.event_id >= COALESCE(noetl.execution.last_event_id, 0)
            THEN EXCLUDED.last_event_type
            ELSE noetl.execution.last_event_type
        END,
        last_node_name = CASE
            WHEN NEW.event_id >= COALESCE(noetl.execution.last_event_id, 0)
            THEN EXCLUDED.last_node_name
            ELSE noetl.execution.last_node_name
        END,
        last_event_id   = GREATEST(noetl.execution.last_event_id, EXCLUDED.last_event_id),
        start_time      = COALESCE(noetl.execution.start_time, EXCLUDED.start_time),
        end_time        = CASE WHEN is_terminal
                               THEN COALESCE(noetl.execution.end_time, EXCLUDED.end_time)
                               ELSE noetl.execution.end_time END,
        error           = CASE WHEN NEW.error IS NOT NULL
                               THEN NEW.error
                               ELSE noetl.execution.error END,
        updated_at      = EXCLUDED.updated_at;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_to_execution ON noetl.event;
CREATE TRIGGER trg_event_to_execution
AFTER INSERT ON noetl.event
FOR EACH ROW EXECUTE FUNCTION noetl.trg_execution_state_upsert();
```

---

## 7. `execution` Table Reconstruction Function

Used for testing and disaster recovery.

```sql
CREATE OR REPLACE FUNCTION noetl.rebuild_execution_projection(p_execution_id BIGINT)
RETURNS VOID AS $$
BEGIN
    -- Delete the projection row
    DELETE FROM noetl.execution WHERE execution_id = p_execution_id;

    -- Replay all events through the trigger
    -- The trigger fires on INSERT; we re-insert synthetic rows to drive the trigger.
    -- In practice, this is done by running a SELECT and calling the trigger function
    -- directly in application code, not via actual re-INSERT.
    --
    -- Application-level reconstruction (Python):
    --   events = await db.fetch("SELECT * FROM noetl.event WHERE execution_id=$1 ORDER BY event_id", eid)
    --   for event in events:
    --       await db.execute("SELECT noetl.trg_execution_state_upsert_apply($1::jsonb)", event_as_json)
    RAISE NOTICE 'Rebuild must be done at application level by replaying events in order.';
END;
$$ LANGUAGE plpgsql;
```

---

## 8. Summary of All DDL Changes

```sql
-- Paste the following block into a migration script or add to schema_ddl.sql after the existing content:

-- Phase 0 / 1: Unique indexes for atomicity
CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_command_issued_command_id
    ON noetl.event (execution_id, (meta->>'command_id'))
    WHERE event_type = 'command.issued' AND meta ? 'command_id';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_loop_done_loop_id
    ON noetl.event (execution_id, (meta->>'loop_id'))
    WHERE event_type = 'loop.done' AND meta ? 'loop_id';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_event_loop_fanin_completed_loop_id
    ON noetl.event (execution_id, (meta->>'loop_id'))
    WHERE event_type = 'loop.fanin.completed' AND meta ? 'loop_id';

-- Phase 1: Fan-in and loop progress query index
CREATE INDEX IF NOT EXISTS idx_event_loop_id_type
    ON noetl.event (execution_id, (meta->>'loop_id'), event_type)
    WHERE meta ? 'loop_id';

-- Phase 1: result_ref store_tier extension
ALTER TABLE noetl.result_ref
    DROP CONSTRAINT IF EXISTS result_ref_store_tier_check;
ALTER TABLE noetl.result_ref
    ADD CONSTRAINT result_ref_store_tier_check
    CHECK (store_tier IN (
        'memory','kv','object','s3','gcs','db','duckdb','eventlog','minio','pvc'
    ));

-- Phase 1: extended trigger (see Section 6 above for full function body)
-- [DROP TRIGGER + CREATE TRIGGER as shown]
```
