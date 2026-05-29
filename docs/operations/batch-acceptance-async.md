---
title: Async Batch Acceptance (202 + request_id)
description: Configure and operate the async /api/events/batch acceptance path with idempotency, status tracking, and metrics.
---

# Async Batch Acceptance (`/api/events/batch`)

NoETL supports an async acceptance contract for worker batch event submission:

1. Persist incoming worker events and a `batch.accepted` marker.
2. Enqueue background processing for routing + `command.issued`.
3. Return `202 Accepted` with a `request_id` immediately.

This decouples client success from transient scheduler delays.

## API contract

`POST /api/events/batch`

- Header: `Idempotency-Key` (recommended for retry safety)
- Response: `202 Accepted`

Example response:

```json
{
  "status": "accepted",
  "request_id": "574939110284985187",
  "event_ids": [574939110284985188, 574939110284985189],
  "commands_generated": 0,
  "queue_depth": 4,
  "duplicate": false,
  "idempotency_key": "worker-1:574939110284985187:..."
}
```

## Status tracking

Polling endpoint:

- `GET /api/events/batch/{request_id}/status`

SSE endpoint:

- `GET /api/events/batch/{request_id}/stream`

Possible states:

- `accepted`
- `processing`
- `completed`
- `failed`

## Failure classes

Error payloads include machine-readable `code` values:

- `ack_timeout`
- `enqueue_error`
- `queue_unavailable`
- `worker_unavailable`
- `processing_timeout`
- `processing_error`

## Configuration

Set these server env vars:

- `NOETL_BATCH_ACCEPT_ENQUEUE_TIMEOUT_SECONDS` (default `0.25`)
- `NOETL_BATCH_ACCEPT_QUEUE_MAXSIZE` (default `1024`)
- `NOETL_BATCH_ACCEPT_WORKERS` (default `1`)
- `NOETL_BATCH_PROCESSING_TIMEOUT_SECONDS` (default `15.0`)
- `NOETL_BATCH_STATUS_STREAM_POLL_SECONDS` (default `0.5`)

## Metrics

Exposed on `/metrics`:

- `noetl_batch_enqueue_latency_seconds_sum`
- `noetl_batch_enqueue_latency_seconds_count`
- `noetl_batch_ack_timeout_total`
- `noetl_batch_queue_depth`
- `noetl_batch_first_worker_claim_latency_seconds_sum`
- `noetl_batch_first_worker_claim_latency_seconds_count`

## Per-phase timings on `batch.completed`

Every `batch.completed` event written to `noetl.event` carries a
sub-phase timing breakdown in its `result.context` JSONB.  Operators
can attribute tail latency to a specific code path (state load,
`save_state` UPDATE, event-log INSERT, command issuance, lock
acquire, etc.) directly from SQL.

### Fields

| field | meaning |
|---|---|
| `processing_ms` | end-to-end wall-clock for the batch job |
| `pool_checkout_ms` | wall-clock to acquire the DB connection from the pool |
| `lock_acquire_ms` | wall-clock to acquire `pg_advisory_xact_lock` for this `execution_id` |
| `state_load_ms` | wall-clock for the initial state read |
| `engine_total_ms` | wall-clock for the entire `handle_event` invocation |
| `save_state_ms` (+ `_calls`) | total time across all `save_state` calls within one `handle_event` |
| `save_state_terminal_lightweight_ms` (+ `_calls`) | time in the terminal-event fast-path UPDATE |
| `persist_event_compat_ms` (+ `_calls`) | time across single-event + batched event-log INSERTs |
| `save_state_coalesced_count` | number of intermediate `save_state` writes elided per `handle_event` |
| `commit_ms` | wall-clock for the final `conn.commit()` |
| `transaction_ms` | engine + commit block wall-clock |
| `issue_commands_ms` | wall-clock for `_issue_commands_for_batch` after the engine returns |
| `actionable_event` | `true` when the event reached `handle_event`; `false` for noop dispatches |
| `commands_generated` | number of `noetl.command` rows emitted |

### Picking a mitigation from data

After a deploy or workload change, the dominant `*_ms` column over
the first ~100 batches tells you which sub-phase is the new
headline cost.

```sql
SELECT (result->'context'->>'commands_generated')::int AS cg,
       COUNT(*) AS n,
       ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
         (result->'context'->>'engine_total_ms')::double precision))::numeric, 2) AS et_p90,
       ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
         (result->'context'->>'save_state_ms')::double precision))::numeric, 2) AS ss_p90,
       ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
         (result->'context'->>'persist_event_compat_ms')::double precision))::numeric, 2) AS pec_p90
FROM noetl.event
WHERE event_type = 'batch.completed'
  AND created_at > NOW() - INTERVAL '30 minutes'
  AND (result->'context'->>'save_state_ms') IS NOT NULL
GROUP BY 1 ORDER BY 1;
```

Three write-elision optimisations ship in the engine to keep these
columns bounded:

- **Terminal-event fast path** — late-arriving events against an
  already-completed execution skip the heavy state JSONB rewrite
  and only advance `last_event_id`.
- **Cascade event-log batching** — `workflow.completed` →
  `playbook.completed` (and the failure equivalent) are persisted
  with one `executemany INSERT`, sharing a single snowflake-ID
  allocation and a single duration lookup.
- **save_state coalescing** — intermediate state writes inside one
  `handle_event` are stashed in a contextvar buffer and flushed
  ONCE at handle_event exit, after all events have been persisted
  (textbook event-sourcing order — append to log first, project
  afterwards).

See the noetl/noetl wiki page
[handle_event timing](https://github.com/noetl/noetl/wiki/handle_event_timing)
for the full architectural breakdown, contextvar plumbing details,
and operator query recipes.
