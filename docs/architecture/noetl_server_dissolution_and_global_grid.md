---
id: noetl_server_dissolution_and_global_grid
title: Server Dissolution and the Global Grid
sidebar_label: Server Dissolution → Global Grid
sidebar_position: 7
---

# Server Dissolution and the Global Grid

**Status:** North-star blueprint — the destination the in-flight umbrellas
(CQRS [#103](https://github.com/noetl/ai-meta/issues/103), Event-WAL
[#104](https://github.com/noetl/ai-meta/issues/104), WASM plug-ins
[#105](https://github.com/noetl/ai-meta/issues/105), references-in-state
[#101](https://github.com/noetl/ai-meta/issues/101), orchestrator throughput
[#102](https://github.com/noetl/ai-meta/issues/102)) are already walking
toward. This doc names the end-state, the runtime split it requires, and the
sequenced path — so the umbrellas read as one road with a destination instead
of parallel tracks.

It is the synthesis of [Ephemeral Blueprints](./ephemeral_blueprints.md)
(the compute-data boundary), the [Event WAL](./event_wal_and_derivable_storage.md)
(NATS-as-WAL + derivable storage), the
[System Pool + WASM Plug-ins](./system_pool_and_wasm_plugins.md) (system logic
as hot-replaceable compiled playbooks), the
[CQRS Write-Path Cutover](./cqrs_write_path_cutover.md) (moving the write path
off the server), and the
[Global Hybrid-Cloud Grid](./noetl_global_hybrid_cloud_grid_distributed_architecture_blueprint.md)
(the topology). Read those first; this ties them together.

## One-paragraph statement

The server stops being a control plane and becomes a **stateless edge**. All
durable state is the **NATS JetStream write-ahead log** plus the **object
store** — there is no Postgres source of truth. All processing is
**event-driven system and data playbooks** running on **sharded worker pools**,
dispatched off NATS subscriptions, not server request handlers. The edge does
exactly three things: terminate the **public API** (gateways and clients),
**address and federate** across the shard grid, and serve **projections on
demand** from the WAL. Internal transport is **Apache Arrow** (Flight across
nodes, shared memory when colocated) carrying **reference URNs** instead of
payloads, over **NATS subjects** keyed by the resource locator. The system is
**sharded by locator key across regions, clouds, and datacenters** — a global
NoETL network.

## 1. The inversion

| Concern | Today (control-plane server) | Destination (edge) |
| :-- | :-- | :-- |
| Event ingest | `POST /api/events` → synchronous Postgres `INSERT` | producer publishes to the shard's JetStream WAL (publish-ack = durability) |
| Orchestration | in-server Rust drive loop | `system/orchestrate` plug-in on the system pool, subscribed to the shard's event stream |
| Read model / projection | server writes `projection_snapshot` | `system/projector` folds the WAL; reads served from cached projections / object-store Feather |
| Durable log | `noetl.event` (Postgres, source of truth) | JetStream stream (source of truth); Postgres demoted, then dropped |
| Large results | inline in events, or `result_store` | object-store Feather, addressed by locator URN; events carry the **reference**, never the payload |
| Server role | everything | public API · addressing/federation · projection-on-demand |

The destination is not a rewrite — it is the existing umbrellas reaching their
limit. The CQRS cutover already moves the write path off the server; this doc
just says where that road ends.

## 2. Kernel / userspace runtime split

If the orchestrator becomes a playbook, something must run the orchestrator.
The answer is an OS-shaped split — small resident kernel, everything else a
playbook:

- **Kernel (resident, minimal, can't be a playbook):** the NATS connection +
  JetStream consumers, the **system-pool scheduler** (dispatches off consumer
  lag), the edge's **addressing/federation table**, and the
  **response-boundary credential scrub**. This is the one component that stays
  compiled-in and must be correct by construction. Think microkernel.
- **System playbooks (kernel services):** orchestrate, project, materialize,
  outbox-publish, cleanup, auth, credential-rotate — **compiled to WASM**
  ([#105](https://github.com/noetl/ai-meta/issues/105)), hot-replaceable, on
  `noetl-worker-system-pool`. These are the logic that used to live in the
  server.
- **User playbooks (userspace):** domain logic on the data worker pools.

The bootstrap question — "what drives the orchestrator-playbook?" — is answered
by the kernel scheduler: it dispatches the `system/orchestrate` block when its
consumer sees new events for an execution. No in-process orchestration logic
survives; the scheduler is a dumb pump, the intelligence is the (replaceable)
plug-in.

## 3. The pure-edge end-state

**No Postgres source of truth.** JetStream is the WAL and the system of record;
the object store holds the derived Feather tier (large results **and**
materialized projection snapshots). The edge owns no database.

The edge surface collapses to three roles:

1. **Public API** — terminate gateway/client requests, session + auth at the
   boundary, SSE/callback delivery. (This is today's gateway role; the edge
   absorbs the thin server API on top of it.)
2. **Addressing + federation** — resolve a locator URN to a cell/shard, route
   to the owning NATS subject space, bridge cross-shard subjects over the
   supercluster. The routing table is inherently edge state.
3. **Projection-on-demand** — answer `GET /api/executions/{id}` from a cached
   projection or an object-store Feather snapshot; on a miss, ask the
   `system/projector` to rebuild that execution's projection from the WAL
   (bounded replay, the block-b mechanism from
   [#103](https://github.com/noetl/ai-meta/issues/103)).

**Write path:** producer (worker) publishes the event to its shard's JetStream
WAL; the publish-ack is the durability boundary; `system/materializer` and
`system/projector` fold it asynchronously. This is exactly
[CQRS cutover Option B](./cqrs_write_path_cutover.md).

**Read path:** edge → projection cache → object-store Feather → (miss)
projector rebuild from the WAL. Reads are eventually-consistent by default with
a read-your-writes path that consults the local buffer ahead of the durable
offset (the [Event WAL](./event_wal_and_derivable_storage.md) read cache).

## 4. How this evolves the data-access boundary

The [data-access boundary](https://github.com/noetl/ai-meta/blob/main/agents/rules/data-access-boundary.md)
rule today says "only the server has direct DB access; workers go through the
API." The pure-edge end-state **moves the boundary** rather than breaking it —
each of the rule's three reasons relocates:

- **Connection-pool isolation** → moot. There is no Postgres pool to exhaust;
  NATS fan-out to thousands of subscribers is native. The reason the rule
  existed (workers scaling 1→50 starving the server's pool) disappears with the
  pool.
- **Sharding readiness** → realized. The locator `shard_key` model *is* the
  sharding; the rule's "future shard routing" is the present.
- **Single point of consistency** (schema, audit, RBAC, scrub) → splits:
  schema/migration becomes the **event-envelope contract** + projection logic;
  audit becomes the **WAL itself** (it is, by construction, the immutable audit
  log); RBAC moves to the **gateway/edge**; the **response-boundary scrub**
  stays in the kernel — credentials never leave a response unmasked, edge or
  not.

So the boundary becomes: **the WAL is the system of record; the edge gatekeeps
responses and federation, not a database.** The rule will need a revision when
the path reaches step 4 below — not before.

## 5. Transport substrate

- **Control + events:** NATS subjects, namespaced by locator (`<cell>.<shard>.<tenant>…`).
  The subscription runtime ([#90](https://github.com/noetl/ai-meta/issues/90),
  Modes A/B/C) is the worker-side mechanism.
- **Bulk data:** **Arrow Flight** (gRPC) across nodes; **shared memory** when
  producer and consumer are colocated (already the worker's `ResultRef.ipc`
  shm hint). Events carry **reference URNs**
  ([#101](https://github.com/noetl/ai-meta/issues/101) +
  [#104](https://github.com/noetl/ai-meta/issues/104) locator), never the
  payload — the 5 MB `command.issued` problem is the canary this already
  fixed.
- **Geo federation:** **NATS superclusters + leaf nodes** connect clusters
  across regions, clouds, and on-prem datacenters. The locator URN resolves to
  a cell, which maps to a NATS account/subject space — so cross-shard routing
  is subject routing, which NATS already does at planet scale.

## 6. The shard grid

- `shard_key = FNV-1a(tenant + project + affinity) % shard_count → region / cell / shard`
  — the stable, tested `noetl_tools::locator` function.
- A **shard** = `{ NATS cluster (WAL) · system + data worker pools · object
  store · an edge }`. **No database.**
- **Cross-shard** executions resolve locator URNs globally; the edge routes;
  the supercluster carries the subjects. Coordination across shards is a saga /
  eventual model keyed by the locator (see §8).
- **Global network:** shards everywhere — a region close to every gateway,
  every tenant pinned to its affinity cell, the grid addressed uniformly by
  URN.

## 7. The sequenced path

Each step is independently shippable and reversible; the system runs in a
hybrid state throughout, never a big-bang.

1. **CQRS cutover, Option B** ([#103](https://github.com/noetl/ai-meta/issues/103)) —
   producer publishes to JetStream; the materializer becomes the sole writer of
   the (still-Postgres) read model. *Shadow gate is green as of 2026-06-17;
   this step is unblocked.*
2. **Orchestrator → system plug-in** ([#105](https://github.com/noetl/ai-meta/issues/105)) —
   extract the drive loop into a WASM `system/orchestrate` playbook subscribed
   to the shard's event stream; the server keeps only the kernel scheduler.
3. **Per-shard NATS-as-WAL** ([#104](https://github.com/noetl/ai-meta/issues/104)) —
   JetStream becomes the durable system of record; Postgres demoted to a
   derived projection.
4. **Drop Postgres-as-source-of-truth → projection-on-demand** — reads served
   from object-store Feather / cache; the edge no longer owns a DB. *(This is
   where the data-access-boundary rule gets its revision.)*
5. **Cross-shard federation** — NATS superclusters + locator routing; the
   global grid lights up.

## 8. The hard parts (named honestly)

- **Orchestration latency.** In-process drive is microseconds; a subscribed
  playbook is milliseconds + a dispatch. Mitigations: the local read-buffer
  ahead of the durable offset, WASM-compiled orchestrator, colocated system
  workers, and event batching — the orchestrator-throughput work
  ([#102](https://github.com/noetl/ai-meta/issues/102)) is already paying this
  down. The bet: the per-shard slice is small enough that per-shard latency
  stays flat as the grid grows.
- **Projection-on-demand cost.** A cold read replays the WAL. Mitigate with
  always-warm projections for active executions, Feather snapshots for cold
  ones, and bounded replay (block-b). Never an unbounded full-history scan on
  the request path.
- **Cross-shard consistency.** Per-shard is linearizable via JetStream;
  cross-shard is a saga / eventual model, with the locator URN as the
  coordination key. This is the genuinely hard distributed-systems work and the
  least specified — it deserves its own design note before step 5.
- **Operability without a database.** No Postgres to `psql` into. Observability
  must come entirely from the WAL + traces — which
  [observability.md](https://github.com/noetl/ai-meta/blob/main/agents/rules/observability.md)
  already mandates (metrics + spans + `execution_id` everywhere). The WAL is
  the debugger.
- **The kernel must stay minimal and correct.** It is the one thing that can't
  be a hot-replaceable playbook. Keep it boring: consumers, a scheduler, a
  routing table, a scrub. Resist putting logic there.

## 9. What stays in the edge forever

Even fully dissolved, the edge cannot give up:

- Public-API termination + session/auth at the gateway boundary.
- The **response-boundary credential scrub** — secrets never leave unmasked.
- The **addressing/federation** routing table — inherently edge.
- The **kernel scheduler + NATS consumers** — the microkernel.

Everything else is a playbook.

## Related

- [Ephemeral Blueprints](./ephemeral_blueprints.md) — the compute-data boundary this completes.
- [Event WAL and Derivable Result Storage](./event_wal_and_derivable_storage.md) — the WAL + Feather tier ([#104](https://github.com/noetl/ai-meta/issues/104)).
- [System Worker Pool and WASM Plug-ins](./system_pool_and_wasm_plugins.md) — system logic as compiled playbooks ([#105](https://github.com/noetl/ai-meta/issues/105)).
- [CQRS Write-Path Cutover](./cqrs_write_path_cutover.md) — step 1 of the path ([#103](https://github.com/noetl/ai-meta/issues/103)).
- [Global Hybrid-Cloud Grid](./noetl_global_hybrid_cloud_grid_distributed_architecture_blueprint.md) — the topology this addresses.
