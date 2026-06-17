---
id: cqrs_write_path_cutover
title: CQRS Write-Path Cutover — Durability Contract
sidebar_label: CQRS Write-Path Cutover
sidebar_position: 10
---

# CQRS Write-Path Cutover — Durability Contract

**Status:** Design note — the entry point for the 2d-3 cutover round
of the CQRS event-log split
([noetl/ai-meta#103](https://github.com/noetl/ai-meta/issues/103)).
The 2a/2b/2d-1/2d-2 scaffold is landed and default-off; the **2a
producer is proven live on kind** (the tailer publishes
`noetl.event → noetl_events`, cursor advancing). This note pins the
one decision the cutover turns on — **where the durability boundary
sits** — before any cutover code lands.

This is the write-path slice of the larger
[Event WAL and Derivable Result Storage](./event_wal_and_derivable_storage.md)
model ([#104](https://github.com/noetl/ai-meta/issues/104)); that
blueprint is the end-state, this note is the safe path to its first
half. It honors the compute-data boundary from
[Ephemeral Blueprints](./ephemeral_blueprints.md) and the
NoETL-owned-data rule from the data-access boundary.

## The one decision: move the durability boundary

Today the **synchronous `INSERT noetl.event` is the durability
boundary**. `POST /api/events` writes the row inside a transaction,
commits, and only then returns 200 — the caller knows the event is
durable because the INSERT committed. Everything downstream (the
tailer, the projector, the materializer) reads *committed rows*.

The cutover moves that boundary to the **JetStream publish-ack**: an
event is durable once the `noetl_events` stream acknowledges the
publish. Once the stream is the WAL, the Postgres INSERT no longer has
to be synchronous — the **materializer** drains the stream and writes
`noetl.event` asynchronously, and a crash between publish-ack and
INSERT loses nothing because the materializer replays from the stream.

Everything in 2d-3 follows from that single move. The current shadow
design can't drop the synchronous INSERT because the tailer's source
*is* the committed rows — so the cutover is not a flag flip; it is the
relocation of the durability boundary plus the consequences below.

## Who publishes to the stream — the key fork

Two shapes put events on `noetl_events` with the publish-ack as the
durability point. The choice is load-bearing.

### Option A — server-mediated publish (recommended first step)

`POST /api/events` **publishes to `noetl_events`** (await publish-ack)
instead of writing `noetl.event` synchronously, then returns 200. The
materializer drains the stream → `POST /api/internal/events/materialize`
→ the async INSERT.

- **Keeps the data-access boundary intact.** Workers still call the
  server API; only the server touches the stream and the platform DB.
  No worker code changes for the durability move itself.
- **Smallest blast radius.** The producer change is one server handler
  (publish instead of INSERT) behind a gate; the worker, the keychain,
  and the dispatch path are untouched.
- The tailer is **deleted** at cutover — its job (get committed rows
  onto the stream) is now done at ingest.

### Option B — worker publishes straight to JetStream (the #104 end-state)

The worker publishes each event to `noetl_events` directly (the shape
the tailer's design note anticipates and the
[Event WAL](./event_wal_and_derivable_storage.md) model assumes — the
local buffer + parallel stream publish per atomic cycle).

- **Lowest latency**, no server hop on the emit path.
- **Crosses the data-access boundary as written today** — a worker
  writing to a NoETL-owned stream. This is reconcilable (the WAL is
  arguably platform infrastructure, like the NATS command bus the
  worker already uses), but it is a **rule change that must be made
  explicitly**, not assumed. Resolve it against the data-access
  boundary before adopting B.

**Recommendation:** land **Option A** for 2d-3 (durability move with
the boundary intact, server-only change), and treat **Option B** as the
#104 follow-on once the boundary question is decided and the local
buffer / read-cache lands. A→B is incremental: the materializer and the
stream contract are identical; only the producer moves from server to
worker.

## Consequences to design before cutover

Moving the boundary breaks three synchronous assumptions. Each needs a
concrete answer in the cutover round.

1. **Orchestrator trigger ordering.** Today `POST /api/events` INSERTs
   then triggers the orchestrator, which `rebuild_state`s from
   `noetl.event`. After the move the row may not be in `noetl.event`
   yet. The orchestrator must advance off the **published event** (the
   in-memory buffer / projection ahead of the materialized offset), not
   off a fresh DB read. The 2b `projector_owns_snapshot` path is the
   read-model half of this; the buffer is the
   [Event WAL](./event_wal_and_derivable_storage.md) read cache.

2. **Read-your-writes on the API.** `GET /api/executions/{id}` and the
   replay endpoints must reflect a just-published event before it
   materializes — i.e. read from the projection/buffer, not only
   `noetl.event`. Define the read path's freshness contract (read at or
   ahead of the last published offset).

3. **Materializer availability is now load-bearing.** In shadow the
   materializer is optional (the synchronous INSERT is the real
   writer). After cutover it is the **sole** `noetl.event` writer, so
   it must run on the system pool with its own scaler, lag metric, and
   alert. The `system/event_materializer` playbook must be **deployed**
   (it is not on kind today) with `nats_system` + the internal API
   token before the flip.

## Durability + idempotency invariants (unchanged by the cutover)

The cutover must preserve, not weaken, these:

- **App-side snowflake `event_id`** (already the rule) — the id exists
  before publish, so the span/metric correlate and retries are
  idempotent.
- **`Nats-Msg-Id = event_id`** on every publish → JetStream message
  dedup collapses a re-publish after a producer retry.
- **`ON CONFLICT (execution_id, event_id) DO NOTHING`** on the
  materializer INSERT → a redelivered stream message is a no-op.
- **`normalize_event_to_row` is the one shared normalizer** for the
  synchronous path and the materializer (already landed, 2d-2) — so the
  materialized log is **byte-identical** to what the synchronous path
  would have written. This is the property the shadow phase verifies.

## Staged rollout

No big-bang flip. The order de-risks the boundary move:

1. **Shadow (now possible).** Enable the tailer + run the materializer
   alongside the synchronous INSERT. The materializer's writes are
   idempotent duplicates; `duplicates ≈ batch` and zero divergence over
   a real workload **proves byte-identical reproduction**. Gate before
   any producer change. *(Needs the materializer playbook deployed —
   the first concrete task of the round.)*
2. **Producer move (Option A), gated.** Add a `skip-synchronous-INSERT`
   server gate (does not exist yet). With it off, behavior is
   unchanged. With it on, `POST /api/events` publishes instead of
   INSERTs; the materializer becomes the real writer. Roll out on kind,
   validate the three consequences above (trigger ordering,
   read-your-writes, materializer lag).
3. **Drop the tailer.** Once ingest publishes directly, the
   committed-row tailer is dead code — delete it.
4. **Production flip + watch.** Enable the gate in GKE behind the
   materializer lag/alert; keep the synchronous path one revert away
   until a full PFT + soak passes.

## What lands in the cutover round

- **ops:** deploy `system/event_materializer` on the system pool (cred
  + token + scaler + lag metric). Prerequisite for the shadow gate.
- **server:** the `skip-synchronous-INSERT` gate on `POST /api/events`
  (publish-on, INSERT-off) + the orchestrator-trigger-off-published and
  read-your-writes-off-projection changes + delete the tailer at the
  end.
- **observability:** materializer consumer lag gauge, publish-ack
  latency histogram, a "materialization behind" alert — shipped in the
  same change set per the observability rule (this path is the new
  bottleneck surface).
- **docs:** fold the validated shape back into the
  [Event WAL](./event_wal_and_derivable_storage.md) blueprint; this note
  becomes its write-path appendix.

## Related

- [Event WAL and Derivable Result Storage](./event_wal_and_derivable_storage.md)
  — the full model this is the first half of ([#104](https://github.com/noetl/ai-meta/issues/104)).
- [Ephemeral Blueprints](./ephemeral_blueprints.md) — the compute-data
  boundary the producer fork must honor.
- [System Worker Pool and WASM Plug-in Surface](./system_pool_and_wasm_plugins.md)
  — where the materializer runs.
