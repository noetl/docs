---
id: event_wal_and_derivable_storage
title: Event WAL and Derivable Result Storage
sidebar_label: Event WAL + Derivable Storage
sidebar_position: 9
---

# Event WAL and Derivable Result Storage

How NoETL makes the event and result path fast **and** crash-resilient
at the same time: treat NATS JetStream as the write-ahead log, run
local memory as a read cache ahead of the last durable offset, derive
result locations from a stable logical URI that resolves to a cell/shard
location instead of carrying
references, and let independent pools project the log and materialise
results to an Arrow Feather tier in object store.

This is the runtime-storage evolution of
[Sink-Driven Data Storage](./sink_driven_storage.md) (the Python-era
result-reference pattern) and a direct consequence of the
[Ephemeral Blueprints](./ephemeral_blueprints.md) compute-data boundary.
It folds together two in-flight efforts — the CQRS event-log split
([noetl/ai-meta#103](https://github.com/noetl/ai-meta/issues/103)) and
results-by-reference / references-in-state
([noetl/ai-meta#101](https://github.com/noetl/ai-meta/issues/101)) —
into one model rather than running them as parallel tracks.

## One-paragraph statement

Every atomic cycle of an execution — a tool result **or** a condition
evaluation — appends an event to a local in-process buffer that the
running orchestrator and worker read from immediately, and publishes the
same event to a NATS JetStream stream in parallel. The JetStream
publish-ack is the durability boundary: the stream is the write-ahead
log. Two independent consumer pools drain that log — a **projector**
that rebuilds the read model (`projection_snapshot`) and a
**materialiser** that writes over-budget result payloads as Arrow
Feather files to object store. Result locations are addressed by a
**stable logical URI** (`noetl://<tenant>/<project>/results/...`) that
resolves to a physical location through the cell / shard model, so state
carries predicate fields and derivable coordinates, never a payload and
never an opaque, placement-coupled reference. A crashed instance resumes
from the last log offset its work was durably acked at and replays only
the local-only tail.

## Why

Three problems, one model.

1. **The synchronous event write is the scaling bottleneck.** Today an
   atomic cycle blocks on a `noetl.event` `INSERT` before it can ack.
   Under fan-out (cursor mode, 10×1000 PFT) that serialises the hot path
   against the database connection pool — exactly the ceiling described
   in the scale-constraints analysis. Moving durability to a JetStream
   publish-ack takes the database off the hot path.

2. **Carried payloads and references bloat state.** Storing full results
   in the event (or, later, carrying an opaque `reference.ref` string and
   re-hydrating it inline so the orchestrator can evaluate guards) pushes
   megabytes back through command context and snapshots. The
   [Ephemeral Blueprints](./ephemeral_blueprints.md) rule is explicit:
   context carries references, not data. A **derivable** location carries
   even less — the coordinates that address it are already in the event
   envelope.

3. **Resilience needs an independent checkpoint.** If the only durable
   record is written synchronously by the same process doing the work, a
   crash mid-cycle loses the tail. An independently-consumed log lets a
   restart resume from a checkpoint it did not have to write itself.

## The model

```
          atomic cycle (tool result | condition eval)
                          │
            ┌─────────────┴──────────────┐
            ▼                             ▼
   local in-process buffer        NATS JetStream  ──  the WAL
   (memory / temp file)           publish-ack = durable
   read cache, ahead of                  │
   last acked offset             ┌───────┴────────┐
            │                    ▼                ▼
   orchestrator / worker    projector pool   materialiser pool
   read the fast path       → projection_     → Arrow Feather in
                              snapshot           object store, keyed
                              (read model)       at logical-URI loc
```

- **Local buffer = read cache.** It accelerates a process reading its
  *own* recent appends. It is not a shared cache: another process never
  reads this process's memory or temp files. Cross-process reads always
  go through the log and the object-store tier (or the colocated shared-
  memory cache for same-node acceleration, which already exists with
  lease expiry).
- **NATS JetStream = WAL.** A publish that waits for the stream ack is
  durable and replicated. Resume-from-offset is well-defined: anything
  past the last ack is replayed.
- **Projector pool** drains the log into `projection_snapshot` (the read
  model the orchestrator reads). This already exists.
- **Materialiser pool** drains the same log, and for over-budget results
  writes Arrow Feather to object store at the logical URI's resolved
  cell/shard prefix. The shadow materialiser consumer already exists;
  this extends it to write the durable Feather tier.

Both drain pools — and every async system service this model adds — run
on the **system worker pool as plug-in-ring playbooks**, not as bespoke
Rust services, per the
[System Worker Pool and WASM Plug-in Surface](./system_pool_and_wasm_plugins.md)
ADR. `system/outbox_publisher` and `system/projector` already run this
way; the materialiser is the same shape — a `system/` playbook that
drains `noetl_events` and calls the server's internal API to write the
Feather tier. The worker's **parallel publish stays in the compiled core**
(it is part of the worker binary's emit path, fired per atomic cycle —
no extensibility need, no per-invocation dispatch cost). The split is:
thin compiled publish on the hot path, system-pool playbooks for the
heavy async drain/materialise/project work. Playbooks that later need
native speed compile to WASM and hot-reload via catalog version bump (the
ADR's Phase 4) — the catalog is the managed, replaceable plug-in library.

## The load-bearing decision: where the durability barrier sits

Local-ahead-of-durable is only crash-safe if the replay window respects
non-idempotent work. The two atomic kinds need **different** treatment:

| Atomic kind | Replay safety | Treatment |
| :-- | :-- | :-- |
| **Condition evaluation** | Pure — re-derives from state for free | Local + asynchronous publish. Never blocks. |
| **Tool execution, no side effect** | Re-runnable | Local + asynchronous publish. |
| **Tool execution with side effects** (charges a card, sends a message, writes an external system) | **Not** replay-safe | Durable boundary: the result's publish-ack is the commit point, and a resume must not re-dispatch a tool whose completion is already durable. |

The rule: **the durability barrier sits at side-effecting tool
boundaries, nowhere else.** Blocking every cycle is just the synchronous
write we are escaping; blocking nowhere re-charges cards on crash.
Concretely, before a resumed execution re-dispatches a side-effecting
tool for `(execution_id, step, frame, row, attempt)`, it checks whether that
cycle's completion is already in the log (equivalently: whether the
derived result URN already exists). If it does, the cycle is skipped and
the recorded result adopted. This is the same shape as the
callback/hook rule — time in the external system is free; the worker
slot is only held while a block actually runs.

## Derivable addresses: the logical URI and topology resolution

NoETL runs as a super-cluster spanning cloud providers, regions, zones,
hybrid datacenters, and Kubernetes clusters, so a result's **name must
resolve to where its bytes live** — without hard-coding a mutable
physical placement into the name. This reuses the platform's existing
two-layer naming from the
[Global Hybrid Supercluster Blueprint](./noetl_global_hybrid_cloud_grid_distributed_architecture_blueprint.md)
(§4 Regional Cell and Shard Model, §7 Object Store Archive, §8 NoETL
Resource Locator) rather than inventing a parallel scheme.

### Layer 1 — the logical URI (stable, location-independent)

```
noetl://<tenant>/<project>/results/<execution_id>/<step>/<frame>/<row>/<attempt>@<version>
```

This is the established NoETL Resource Locator shape
(`noetl://<tenant>/<project>/<kind>/<logical_path>@<version>`). It is
what state carries and what dedup / replay key on, and it **never
changes** when data is replicated, migrated, or fails over — that is the
whole point of a *name* rather than a *locator*. Encoding
provider/region/cluster literally into the name would couple identity to
mutable placement and break failover; topology is **resolved from** the
name, not baked **into** it.

- `tenant` and `project` lead — the multitenancy + sharding dimensions
  (the coordinates an earlier draft of this doc omitted).
- `execution_id` and `step` are in the event envelope.
- `frame` **and** `row` are **mandatory** for fan-out — a `mode: cursor`
  loop fans out twice: the orchestrator claims a **frame** of rows, then
  dispatches one body command per **row** in that frame (the body command
  carries `metadata.cursor = {frame, row}`). Each body command produces one
  result, so `(frame, row)` is what makes a result unique within its step;
  `frame` alone collides across the rows of a frame. Both are `0` for a step
  that does not fan out.
- `attempt` / `@version` disambiguate retries: fix the version to
  **overwrite** (idempotent), bump it to **keep every attempt**.

### Layer 2 — topology resolution (derivable, then a small registry)

The logical URI resolves to a physical location through the §4 shard
model, not a per-result lookup:

```
shard_key = hash(tenant_id + project_id + execution_affinity) % shard_count
          → region + cell + shard
```

which yields the §7 physical object prefix:

```
noetl/env=<env>/region=<region>/cell=<cell>/shard=<shard>/
      tenant=<tenant>/project=<project>/date=<date>/
      execution=<execution_id>/results/<step>/<frame>/<row>/<attempt>.feather
```

A consumer that knows `(tenant, project, execution_id)` therefore
**derives** the home region / cell / shard and the prefix with zero
central lookup — the "find without passing references" property, made
topology-aware. The only thing that needs a registry is the small,
slow-changing **cell endpoint map** (cell → provider / bucket /
endpoint) — the DNS-of-cells: dozens of entries, cacheable, not a
per-fetch single point of failure.

### Replication, DR, and the location descriptor

When a result is replicated across providers / regions for DR, the
logical URI is unchanged; the §8 **location descriptor** carries N
`locations[]` (`s3` / `gcs` / `azure` / Ceph RGW / SeaweedFS) each with a
`replica_state` (`primary` / `async-replica`), and

```
resolve(noetl_uri, requester, purpose, preferred_region, required_capability)
  → access plan
```

returns the nearest healthy replica. Failover renames nothing. Honoring
the §4 cell principles, cell-to-cell exchange carries these references
and manifests — never raw cross-cell database writes — the same boundary
the materialiser pool already respects.

What the model buys: **idempotent overwrite** (a fixed version rewrites
the same key), **trivial GC** (per-shard / per-execution prefix delete),
**deterministic replay** (the name is computed from the envelope + shard
function, never carried), and **locality-aware routing** (the shard
resolves the home cell so a consumer prefers the nearest replica).

## Result tiers

The size threshold that already gates inline-vs-reference
(`NOETL_EVENT_RESULT_CONTEXT_MAX_BYTES`) selects the tier:

1. **Small result** → stays inline in the event. No object-store write.
2. **Over-budget tabular result** → Arrow Feather at the logical URI's resolved location.
   Feather is the on-disk/object-store form of the Arrow IPC stream the
   worker already encodes for the shared-memory cache; it is mmap-able and
   reads zero-copy from `pyarrow` and the Rust `arrow` crate.
3. **Over-budget non-tabular result** (shell stdout, opaque HTTP JSON)
   → JSON (or Parquet) at the same resolved location. Feather is for rowsets;
   the rest needs a fallback encoding.

In **all** tiers the event carries a small **predicate `extracted`
block** inline — the navigable, bounded summary the orchestrator reads
to evaluate `when:` / `set:` / cursor fan-out **without** a fetch. This
is the structural-summary mechanism already built for references-in-
state (objects keep their keys, arrays keep their first element so
`rows[0].<field>` resolves, large strings collapse to a length marker,
the whole block is byte-bounded). It survives this model unchanged — the
only thing that goes away is the opaque `reference.ref` string, replaced
by derivation.

## Crash recovery semantics

1. A restarted instance reads the read model and the log up to the last
   offset its executions were durably acked at.
2. It replays the local-only tail: pure condition evaluations re-derive
   for free; non-side-effecting tools re-run; side-effecting tools are
   **skipped if their completion is already durable** (the logical URI's
   object already exists / the cycle is acked), otherwise dispatched.
3. The projector and materialiser are at-least-once consumers and must be
   idempotent — dedup on `event_id`, overwrite at the logical URI's
   resolved location. Both properties are already required by the CQRS
   projector.

## What already exists vs what is new

**Already scaffolded (CQRS + results-by-reference work):**

- `noetl_events` JetStream stream, the **projector** consumer →
  `projection_snapshot`, and a shadow **materialiser** consumer — the
  "separate process reads NATS and writes elsewhere" pools.
- The Arrow IPC encoder and the colocated shared-memory cache with lease
  expiry — columnar staging and same-node fast reads.
- The durable result store and the inline-vs-reference size threshold.
- The bounded, navigable predicate `extracted` block.
- Application-side snowflake IDs (so identity exists before the write).

**New in this model (the three pieces):**

1. **Logical-URI addressing** — the stable `noetl://<tenant>/<project>/...`
   Resource Locator; drop the carried opaque reference and derive the
   location from identity.
2. **Local-first dual write** — the worker's local buffer is the fast
   path; the JetStream publish is the durability channel (extends the
   2d-3 worker-publish direction). Stays in the compiled core.
3. **Arrow Feather durable tier** under the materialiser — a **plug-in-ring
   `system/` playbook** on the system worker pool, optionally WASM-compiled
   for native speed and hot-reloaded via catalog version bump (the
   [system-pool ADR](./system_pool_and_wasm_plugins.md) Phase 4).

## How it folds into the open work

- **[noetl/ai-meta#103](https://github.com/noetl/ai-meta/issues/103)
  (CQRS event-log split)** provides the stream, the projector, and the
  materialiser. The 2d-3 step (worker publishes its native event shape to
  the stream) becomes the local-first dual write here.
- **[noetl/ai-meta#101](https://github.com/noetl/ai-meta/issues/101)
  (references-in-state)** provides the predicate `extracted` block, which
  stays. Its carried `reference.ref` string is superseded by derivation.

The two stop being separate tracks: one is the log + projection, the
other is the result tier addressed off the same log. This document is the
umbrella they both serve.

## Open questions (red-team targets)

- **Attempt/version semantics in the logical URI** — overwrite-on-retry (omit/fix
  `attempt`) vs keep-every-attempt. Overwrite is simpler and GC-friendly;
  keep-every is better for forensic replay. Likely: overwrite by default,
  keep-every behind a debug flag.
- **Local tail bound** — how far local may run ahead of the last ack
  before back-pressure. Too far widens the replay window and the
  idempotency burden; too tight approaches the synchronous write.
- **Non-tabular fallback format** — JSON vs Parquet for the over-budget
  non-tabular tier.
- **Side-effect classification** — how a tool declares itself
  side-effecting so the barrier knows where to block. A tool-registry
  attribute is the natural home.

## Relationship to the boundary rules

This model honors — and sharpens — the platform's boundary rules:

- **[Ephemeral Blueprints](./ephemeral_blueprints.md)** — context carries
  references, not data; derivation carries even less.
- **NoETL-owned data via the server API only** — workers publish to the
  stream and read the object-store tier; they do not reach `noetl.*`
  tables directly. The materialiser and projector pools are system-pool
  consumers that call the server's internal API for anything touching
  NoETL-owned tables.
- **Observability** — every new boundary (publish, materialise, resolve
  by URN) ships its span, metric, and `execution_id` correlation in the
  same change set.
