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
result locations from a naming convention instead of carrying
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
Feather files to object store. Result locations are **derived from a
naming convention** (a URN computed from the execution identity), so
state carries predicate fields and derivable coordinates, never a
payload and never an opaque reference string. A crashed instance resumes
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
                              (read model)       by derived URN
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
  writes Arrow Feather to object store under the derived URN. The shadow
  materialiser consumer already exists; this extends it to write the
  durable Feather tier.

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
tool for `(execution_id, step, frame, attempt)`, it checks whether that
cycle's completion is already in the log (equivalently: whether the
derived result URN already exists). If it does, the cycle is skipped and
the recorded result adopted. This is the same shape as the
callback/hook rule — time in the external system is free; the worker
slot is only held while a block actually runs.

## Derivable URN grammar

The location is a pure function of execution identity. It must encode
everything that distinguishes one result from another, or fan-out and
retries collide on the same key:

```
urn:noetl:result:<execution_id>:<step>:<frame_or_claim_index>:<attempt>
```

- `execution_id` and `step` are already in the event envelope.
- `frame_or_claim_index` is **mandatory** for fan-out. Cursor mode
  produces many results per step; without the index, row 0 and row 5
  write the same object and corrupt each other.
- `attempt` disambiguates retries when you want both kept; omit it (or
  fix it at the latest) when you want retries to **overwrite**.

The object-store key is a deterministic encoding of the URN, e.g.

```
noetl/<execution_id>/<step>/<frame>/<attempt>.feather
```

What the convention buys:

- **Idempotent overwrite.** A retry that fixes `attempt` rewrites the
  same key — no orphaned objects, single atomic PUT, clean reads.
- **Trivial garbage collection.** TTL or end-of-execution cleanup is a
  prefix delete (`noetl/<execution_id>/`).
- **Deterministic replay.** The projector and any consumer **compute**
  the URN from the envelope; the event never carries it. State shrinks to
  the coordinates already present plus the predicate block below.
- **Prefix discovery.** "All results for execution X" is a prefix list,
  not a reference set to thread through state.

## Result tiers

The size threshold that already gates inline-vs-reference
(`NOETL_EVENT_RESULT_CONTEXT_MAX_BYTES`) selects the tier:

1. **Small result** → stays inline in the event. No object-store write.
2. **Over-budget tabular result** → Arrow Feather under the derived URN.
   Feather is the on-disk/object-store form of the Arrow IPC stream the
   worker already encodes for the shared-memory cache; it is mmap-able and
   reads zero-copy from `pyarrow` and the Rust `arrow` crate.
3. **Over-budget non-tabular result** (shell stdout, opaque HTTP JSON)
   → JSON (or Parquet) under the derived URN. Feather is for rowsets;
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
   **skipped if their completion is already durable** (URN exists / cycle
   acked), otherwise dispatched.
3. The projector and materialiser are at-least-once consumers and must be
   idempotent — dedup on `event_id`, overwrite on the derived URN. Both
   properties are already required by the CQRS projector.

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

1. **Derivable URN addressing** — drop the carried reference; derive the
   location from identity.
2. **Local-first dual write** — the worker's local buffer is the fast
   path; the JetStream publish is the durability channel (extends the
   2d-3 worker-publish direction).
3. **Arrow Feather durable tier** under the materialiser, keyed by URN.

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

- **Attempt semantics in the URN** — overwrite-on-retry (omit/fix
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
