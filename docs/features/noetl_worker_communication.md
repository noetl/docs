---
sidebar_position: 42
title: NoETL Worker Communication Architecture
description: Analysis and decision on worker-to-server and worker-to-worker communication patterns — HTTP API, NATS, WebSocket, and fan-out/fan-in coordination.
---

# NoETL Worker Communication Architecture

## Current State

Workers communicate with the server via two channels:

| Direction | Transport | Operations |
|---|---|---|
| Server → Worker | NATS JetStream (push) | Command notifications (lightweight: `{execution_id, event_id, command_id, server_url}`) |
| Worker → Server | HTTP GET | Fetch full command context: `GET /api/commands/{event_id}` |
| Worker → Server | HTTP POST | Emit events: `POST /api/events` or `POST /api/events/batch` |
| Worker → Worker | None | Workers do not communicate with each other |

The server publishes a lightweight NATS message; the worker fetches the full command payload over HTTP. Workers emit results over HTTP to the server API, which persists events and drives routing.

---

## Question 1: Should Workers Communicate Directly via NATS?

**Decision: No.**

The server is the sole routing authority. Workers must never synthesize routing decisions or coordinate state with each other. If Worker A and Worker B each hold a shard of the same loop, neither needs to know about the other's progress. The server counts `loop.shard.done` events in the `noetl.event` table and triggers `loop.fanin.completed` when the count is reached. This is a pure server-side aggregation with no inter-worker coordination.

**Why direct worker-to-worker would be harmful:**

1. **Routing authority violation.** If Worker A tells Worker B "I'm done, proceed," Worker B is making a routing decision without server involvement. This bypasses event persistence, deduplication checks, and `next.arcs` evaluation.
2. **State loss on worker crash.** If Worker A crashes after telling Worker B but before the server persists the completion event, the system is in an inconsistent state with no recovery path.
3. **Observability gap.** Server-side event persistence is the audit trail. Worker-to-worker messages that bypass the event table are invisible to monitoring, replay, and debugging.
4. **Fan-out design is already correct without it.** The fan-in count query against `noetl.event` is a single-partition indexed scan — it is fast and requires no inter-worker coordination.

**The one case where it might seem necessary — aggregation:** If shards need to aggregate results (e.g., a running sum), the correct pattern is for each shard to write its partial result to a shared store (MinIO/PostgreSQL) and the fan-in step to aggregate after completion. This is already supported via the `manifest` + `manifest_part` tables.

---

## Question 2: Should We Add WebSocket / Persistent Socket Connections?

**Decision: No — NATS already provides persistent connection semantics.**

WebSocket or raw socket connections from workers to the server would provide:
- Persistent connection (avoids HTTP handshake per request)
- Server-push capability (server sends commands without worker polling)

But these are already covered:
- **NATS provides a persistent connection** maintained by the NATS client library, with automatic reconnection, flow control, and message acknowledgement. Workers already have a NATS connection for receiving commands; this same connection is used for event publication (Phase 4).
- **Server-push is already implemented** via NATS command notifications.
- **WebSocket adds state management burden** — the server must track which socket maps to which worker, handle disconnections, and buffer messages during reconnection. NATS handles all of this.

Adding WebSocket would duplicate what NATS already does, with more failure modes and no benefit.

---

## Question 3: Should Event Emission Switch from HTTP to NATS?

**Decision: Yes, for high-frequency events. HTTP retained for synchronous operations.**

### Current problem with HTTP event emission

Every loop iteration generates at least two HTTP round-trips:
1. `POST /api/events` for `command.claimed`
2. `POST /api/events` (or batch) for `command.completed`

For a 1000-patient × 5 data-type workload with `max_in_flight=20`, that is ~10,000 HTTP requests for event emission alone. Each HTTP request involves connection setup (or keepalive reuse), TLS negotiation (in production), and a full server-side request/response cycle.

### Proposed transport split

| Event type | Transport | Reason |
|---|---|---|
| `command.claimed` | **HTTP POST** (keep) | Synchronous: advisory lock result must be returned to worker |
| `command.completed` | **NATS publish** (new) | Fire-and-forget with JetStream persistence |
| `command.failed` | **NATS publish** (new) | Fire-and-forget with JetStream persistence |
| `command.heartbeat` | **NATS publish** (new) | High-frequency, no response needed |
| `loop.shard.done` | **NATS publish** (new) | High-frequency during fan-out |
| `loop.shard.failed` | **NATS publish** (new) | High-frequency during fan-out |
| `call.partial` | **NATS publish** (new) | Streaming chunk events |
| `command.context fetch` | **HTTP GET** (keep) | Pull operation; response body is the payload |
| Worker registration | **HTTP POST** (keep) | Management operation |
| Health check | **HTTP GET** (keep) | Management operation |

### NATS JetStream configuration for worker events

```
Stream name:    NOETL_WORKER_EVENTS
Subjects:       noetl.events.>           (wildcard: noetl.events.{execution_id}.{event_type})
Retention:      WorkQueuePolicy           (events consumed exactly once by server)
Storage:        File (JetStream)          (survives NATS restart)
Replicas:       1 (kind/local), 3 (GKE)
MaxAge:         1h                        (events older than 1h are auto-deleted)
MaxMsgSize:     64KB                      (large results must be externalized first)
```

Subject format: `noetl.events.{execution_id}.{event_type}`

Examples:
```
noetl.events.604876797720658689.command.completed
noetl.events.604876797720658689.loop.shard.done
noetl.events.604876797720658689.command.heartbeat
```

Server subscribes to `noetl.events.>` with a push consumer. Each message is processed by the same `handle_event()` pipeline as the HTTP path.

### Worker publish (Python)

```python
# In nats_worker.py, replacing _emit_batch_events for non-claimed events:
async def _emit_event_nats(
    self,
    name: str,
    payload: dict,
    meta: dict,
    execution_id: str,
) -> None:
    if not self._use_nats_transport:
        return await self._emit_event(name=name, payload=payload, meta=meta)

    subject = f"noetl.events.{execution_id}.{name.replace('.', '_')}"
    message = {
        "execution_id": execution_id,
        "event_type": name,
        "payload": payload,
        "meta": meta,
        "worker_id": self.worker_id,
        "timestamp": utcnow_iso(),
    }
    data = json.dumps(message).encode()
    ack = await self._nats_js.publish(subject, data)
    # JetStream publish returns an ack; log if sequence is unexpected
    logger.debug("[NATS-EMIT] published %s seq=%d", name, ack.seq)
```

### Server consumer (Python)

```python
# In server/app.py startup, alongside existing NATS command publisher:
async def _start_worker_event_consumer():
    js = nats_client.jetstream()
    consumer = await js.subscribe(
        "noetl.events.>",
        stream="NOETL_WORKER_EVENTS",
        cb=_handle_worker_event_message,
        durable="server-worker-events",
    )

async def _handle_worker_event_message(msg: nats.aio.client.Msg):
    try:
        data = json.loads(msg.data)
        event = Event(
            execution_id=data["execution_id"],
            name=data["event_type"],
            payload=data["payload"],
            meta=data["meta"],
        )
        await handle_event(event)          # same pipeline as HTTP path
        await msg.ack()
    except Exception as e:
        logger.error("[NATS-CONSUMER] failed to process event: %s", e)
        await msg.nak()                    # redelivery with backoff
```

### Backwards compatibility

Workers default to `NOETL_EVENT_TRANSPORT=http` (existing behavior). Opt-in per deployment:

```bash
# kind/local with NATS transport:
NOETL_EVENT_TRANSPORT=nats
NOETL_EVENT_NATS_SUBJECT_PREFIX=noetl.events

# GKE production (gradual rollout):
NOETL_EVENT_TRANSPORT=nats    # after NOETL_WORKER_EVENTS stream is provisioned
```

Mixed deployments (some workers HTTP, some NATS) are supported because both paths write to the same `noetl.event` table via the same `handle_event()` function.

---

## Question 4: Command Context Fetch — HTTP or NATS?

**Decision: Keep HTTP GET.**

The command context fetch (`GET /api/commands/{event_id}`) is a **pull operation** — the worker requests a specific payload by ID. This maps naturally to HTTP:
- The response body carries the full command payload (up to 8KB inline, with external ref for larger)
- HTTP caching headers can be used (command payloads are immutable once issued)
- A single request per command is not a bottleneck compared to the N events emitted per command

NATS request-reply could replace this, but:
- Request-reply in NATS requires a transient reply subject per request — more complex than HTTP GET
- The server already handles HTTP GET efficiently
- No measurable performance gain justifies the added complexity

**Alternative for very large command contexts:** Instead of HTTP fetch, the worker can read the command context directly from MinIO/GCS when `context_key` is a storage URI. The HTTP endpoint remains the same but returns only the URI, and the worker fetches from storage in parallel. This is already partially implemented via `context_key` column.

---

## Recommended Final Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SERVER (Python)                             │
│                                                                      │
│  FastAPI API (HTTP)                                                  │
│  ├─ POST /api/events          ← command.claimed (sync advisory lock) │
│  ├─ GET  /api/commands/{id}   ← worker fetches command context       │
│  ├─ GET  /api/executions/{id} ← status from execution projection     │
│  └─ management endpoints                                             │
│                                                                      │
│  NATS Consumer (async)                                               │
│  └─ noetl.events.> ← command.completed/failed/heartbeat/shard.*     │
│                                                                      │
│  NATS Publisher (async)                                              │
│  └─ noetl.commands.>  → broadcast command notifications              │
│  └─ noetl.commands.{worker_id} → targeted dispatch (Phase 4.3)      │
└─────────────────────────────────────────────────────────────────────┘
                     ↑ NATS JetStream ↓
┌─────────────────────────────────────────────────────────────────────┐
│                          WORKER (Python / Rust)                      │
│                                                                      │
│  NATS Subscriber                                                     │
│  └─ noetl.commands.>  → receives command notifications               │
│  └─ noetl.commands.{self.worker_id} → receives targeted commands     │
│                                                                      │
│  NATS Publisher                                                      │
│  └─ noetl.events.{execution_id}.command.completed                   │
│  └─ noetl.events.{execution_id}.command.failed                      │
│  └─ noetl.events.{execution_id}.command.heartbeat                   │
│  └─ noetl.events.{execution_id}.loop.shard.done                     │
│  └─ noetl.events.{execution_id}.loop.shard.failed                   │
│  └─ noetl.events.{execution_id}.call.partial                        │
│                                                                      │
│  HTTP Client (kept for synchronous ops)                              │
│  └─ POST /api/events  → command.claimed only                         │
│  └─ GET  /api/commands/{id} → fetch command context                  │
└─────────────────────────────────────────────────────────────────────┘

No worker-to-worker communication. All coordination through the server.
```

---

## Migration Plan

### Step 1 — Provision NATS stream (no code change)

```bash
nats stream add NOETL_WORKER_EVENTS \
  --subjects "noetl.events.>" \
  --storage file \
  --retention work \
  --max-age 1h \
  --max-msg-size 65536 \
  --replicas 1
```

Add to `ops/helm/noetl/templates/nats-stream-init.yaml` as a Job that runs `nats stream add` on cluster startup.

### Step 2 — Add server NATS consumer (additive, no HTTP change)

Add `_start_worker_event_consumer()` to `server/app.py` startup. Routes to existing `handle_event()`. HTTP path unchanged. Deploy.

### Step 3 — Enable NATS transport on workers (per-deployment opt-in)

```bash
NOETL_EVENT_TRANSPORT=nats
```

Verify in kind cluster with `test_pft_flow`. Roll out to GKE after kind validation.

### Step 4 — Add targeted dispatch subjects (Phase 4.3)

After capacity registry (Phase 4.2) is live, server starts publishing to `noetl.commands.{worker_id}` for capacity-routed commands. Workers subscribe to both broadcast and targeted subjects.

---

## Performance Expectations

| Metric | HTTP (current) | NATS (Phase 4) |
|---|---|---|
| Event emission latency (p50) | ~5–15ms (HTTP round-trip) | ~0.5–2ms (NATS publish + async ACK) |
| Event emission throughput | ~200–500 events/s per worker | ~5,000–20,000 events/s per worker |
| Connection overhead | Per-request (keepalive amortizes) | Zero (persistent NATS connection) |
| Backpressure mechanism | HTTP 503 + AIMD backoff | NATS flow control (publisher blocks when consumer is slow) |
| Exactly-once semantics | HTTP + DB dedup check | NATS JetStream sequence + DB unique index |

At 20 parallel loop iterations per worker with 3 workers, HTTP overhead is ~60 concurrent HTTP connections to the server. NATS reduces this to 3 persistent NATS connections (one per worker) with message multiplexing.
