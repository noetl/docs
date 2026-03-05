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
