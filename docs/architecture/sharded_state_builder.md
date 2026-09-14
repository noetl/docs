---
id: sharded_state_builder
title: Object-Store-Backed Sharded State Builder
sidebar_label: Sharded State Builder
sidebar_position: 13
---

# Object-Store-Backed Sharded State Builder

**Status:** RFC — design only. No code, no production change.
**Owner umbrella:** the off-server CQRS drive trail
([#104](https://github.com/noetl/ai-meta/issues/104),
[#115](https://github.com/noetl/ai-meta/issues/115),
[#116](https://github.com/noetl/ai-meta/issues/116),
[#130](https://github.com/noetl/ai-meta/issues/130),
[#156](https://github.com/noetl/ai-meta/issues/156)).
**Trigger:** the recurring system-pool OOM / wedge
([#163](https://github.com/noetl/ai-meta/issues/163),
[#161](https://github.com/noetl/ai-meta/issues/161)).

How NoETL replaces the system-pool worker's unbounded in-memory
WAL chain-index with an object-store-backed, sharded, cached
state model: durable state/event-index shards live in the
[#104](https://github.com/noetl/ai-meta/issues/104) Arrow Feather
tier on object store; workers hold a **bounded LRU/TTL cache** of
hot shards and rebuild any miss from the tier. Memory becomes
`O(active working set)` instead of `O(all event history)`.

This is the storage evolution of the
[Event WAL and Derivable Result Storage](./event_wal_and_derivable_storage.md)
model — it extends the same Feather tier from result bytes to
state/event-index shards — and the durable answer to the per-hop
latency floor described in
[Decoupled Context + Event Chain](https://github.com/noetl/ai-meta/wiki/Umbrella-Decoupled-Context-Event-Chain).

---

## 1. Problem statement

### 1.1 What the index is today

`NOETL_STATE_BUILDER=offserver` makes the system-pool worker the
authoritative builder of every execution's drive state. Each
inter-step hop dispatches a `__offserver_build__` command; the
worker answers it from an in-process index of the `noetl_events`
WAL rather than scanning `noetl.event`
([#115](https://github.com/noetl/ai-meta/issues/115) Phase 4).
The index is `WalEventIndex` in
[`repos/worker/src/state_builder.rs`](https://github.com/noetl/worker/blob/main/src/state_builder.rs):

```rust
pub struct WalEventIndex {
    chains: HashMap<i64, ExecutionChain>,   // keyed by execution_id
    order: SpineOrder,
}

pub struct ExecutionChain {
    events: HashMap<i64, IndexedEvent>,      // keyed by event_id
    head: Option<i64>,
    cache: Option<CachedSpine>,
    order: SpineOrder,
}

struct IndexedEvent {
    prev_event_id: Option<i64>,
    event_type: String,
    raw: serde_json::Value,   // <-- the FULL event envelope, kept verbatim
}
```

The drain loop (`run_drain_loop`) consumes the `noetl_events`
stream and calls `WalEventIndex::apply` per event, which clones the
**entire event payload** into `IndexedEvent::raw`. The comment on
the field states the reason: *"kept so a chain walk can hand the
ordered spine to a `from_events` build verbatim."* The chain walk
itself (`chain_walk_from`) needs only `prev_event_id` +
`event_type`; the full `raw` is retained purely so the spine can
be replayed into the wasm `from_events` entry without a second
fetch.

### 1.2 The measured numbers

Measured on the prod system-pool worker at idle
([#163](https://github.com/noetl/ai-meta/issues/163) /
session `163-system-pool-oomkill-mem-rightsizing`):

| Metric | Value |
| :-- | :-- |
| Indexed executions resident | **654** |
| Indexed events resident | **17,803** |
| Resident memory at idle | **~1.28 GiB** |
| Bytes per event (full envelope) | **~73 KiB** |
| Events per execution (mean) | ~27 |
| Memory limit (post-#163 bump) | 2 Gi (was 768 Mi → 97% → OOM) |
| Step-pool worker comparison | ~9 MiB (no off-server index) |

`654 × 27 × 73 KiB ≈ 1.28 GiB` — the resident set is dominated by
`IndexedEvent::raw`, not by the chain links. The chain links
themselves (`prev_event_id` + `event_type` + the `event_id` key)
are a few dozen bytes per event; the **full envelope clone is
~99% of the footprint**.

### 1.3 Why it grows unbounded

There *is* eviction — `WalEventIndex::evict` removes a chain when
the drain observes a terminal event
(`playbook_completed` / `playbook_failed` / `playbook_cancelled`,
`TERMINAL_EVENT_TYPES`), called from `run_drain_loop` after each
batch. **Terminal eviction is necessary but not sufficient.** None
of the following is bounded:

1. **Concurrent live executions.** Nothing caps how many
   non-terminal executions are resident at once. A burst of
   long-running playbooks pins their full event history for their
   whole lifetime.
2. **Stuck / abandoned executions.** An execution that never emits
   a terminal event (wedged, cancelled out-of-band, orphaned by a
   crash) is **never evicted** — its chain lives until the process
   restarts. The [#163](https://github.com/noetl/ai-meta/issues/163)
   wedge is exactly this class.
3. **Per-event bytes.** Each retained event is the full envelope.
   There is no slimming, no reference-only retention, no cap on
   payload size held in the index.
4. **Restart replay spike.** The default off-server drain uses an
   **ephemeral `DeliverPolicy::All` consumer**
   ([#119](https://github.com/noetl/ai-meta/issues/119)): on every
   boot it re-delivers the **entire retained WAL** (the
   `noetl_events` stream is bounded `max_age=24h`, `discard=old`),
   rebuilding the index from up to 24h of events before
   terminal-evictions can trim it. The transient post-restart peak
   is the full retained window, not the steady-state working set.

There is **no LRU, no TTL, no max-bytes ceiling, no cap on
concurrent-live executions.** The structure is
`O(all non-terminal event history × full-envelope-size)` with an
unbounded tail. Raising the memory limit (768 Mi → 2 Gi in #163)
moves the OOM date; it does not change the slope. This is not
viable architecture.

### 1.4 What "good" looks like

- Resident memory `O(active working set)` — the executions a
  worker is currently *driving* — independent of total event-log
  size and of how many executions have ever run.
- A hard, configurable memory ceiling that the cache honors by
  eviction, not by OOM.
- Durable state that survives a restart without a full 24h WAL
  replay.
- The per-hop drive latency floor
  ([#130](https://github.com/noetl/ai-meta/issues/130) /
  [#156](https://github.com/noetl/ai-meta/issues/156)) preserved or
  improved — cache hits stay in-memory; only cold misses pay an
  object-store fetch.

---

## 2. Target architecture

Object store is the **source of truth** for state/event-index
shards (Arrow Feather, reusing the
[#104](https://github.com/noetl/ai-meta/issues/104) tier). Workers
are **caching/projection compute**: they hold a bounded LRU/TTL
cache of hot shards and rebuild any miss by reading the shard from
object store — never by scanning `noetl.event`, never by replaying
the whole 24h WAL.

```
                         INGEST PATH (write)
  worker step ── command.completed ──► NATS JetStream `noetl_events` (WAL, 24h)
                                              │
              ┌───────────────────────────────┼───────────────────────────┐
              ▼                               ▼                            ▼
   materializer consumer            projector consumer        STATE-SHARD writer (NEW)
   → noetl.event (audit)            → projection_snapshot      → Feather shard per
   [sole writer, #103]              [read model]                 (shard, execution)
                                                                 in object store (#104 tier)
                                                                 via PUT /api/internal/objects/{key}

                         QUERY / DRIVE PATH (read)
  server issues __offserver_build__ (execution_id, expected_head, trigger_event_id)
              │
              ▼   execution-affinity route (#116: XxHash64(execution_id))
   ┌─────────────────────────────────────────────────────────────────┐
   │  STATEFUL worker owning shard_for(execution_id)                   │
   │  ┌──────────────────────────────────────────────────────────┐    │
   │  │ Bounded LRU/TTL cache  (O(active working set), hard cap)   │    │
   │  │   hit ──────────► advance chain to expected_head ──► spine │    │
   │  │   miss ─┐                                                  │    │
   │  └─────────┼──────────────────────────────────────────────────┘   │
   │            ▼ cold-load shard (Feather) from object store          │
   │   GET /api/internal/objects/{key}  ──► decode ──► populate cache  │
   └─────────────────────────────────────────────────────────────────┘
              │ spine (ordered events) ──► wasm from_events ──► drive decision
              ▼
        next command.issued
```

Three roles, all already present in some form:

- **Ingest** — the existing `noetl_events` WAL + a **new
  state-shard writer** consumer that drains the WAL into Feather
  shards (a sibling of today's `result_materializer` consumer, see
  §4.4). The WAL stays the durability boundary; the synchronous
  path is untouched.
- **Drive/query** — the existing `__offserver_build__` dispatch,
  now reading from a bounded cache backed by the shard store
  instead of an unbounded resident index.
- **Cache** — a bounded `WalEventIndex` (LRU + TTL + byte ceiling)
  per stateful worker, populated lazily on a drive request and
  trimmed under pressure.

The invariant that makes this safe is unchanged from
[#115](https://github.com/noetl/ai-meta/issues/115): **the drive
never scans `noetl.event`.** Today it reads the resident WAL index;
tomorrow it reads a cache that cold-loads from the Feather tier. In
both cases `noetl.event` stays audit-only.

---

## 3. Sharding / hashing model

### 3.1 Two hash spaces exist today — reconcile, don't invent

The codebase already has **two** stable hashes, for two different
purposes. The RFC reuses both as-is rather than adding a third:

| Hash | Where | Key | Purpose |
| :-- | :-- | :-- | :-- |
| **XxHash64** (fixed seed) | `repos/server/src/sharding.rs` `shard_for` / `ShardConfig::owns` | `execution_id` | Which **server replica / worker** owns an execution's drive ([#116](https://github.com/noetl/ai-meta/issues/116) execution-affinity). |
| **FNV-1a 64** | `noetl-locator` (`noetl-tools`) `shard_key` | `tenant ‖ project ‖ execution_id` | Which **object-store shard folder** holds an execution's result bytes ([#104](https://github.com/noetl/ai-meta/issues/104), `NOETL_RESULT_SHARD_COUNT`=256, `s{shard:04}`). |

These answer different questions and must not be collapsed:

- **Object-store folder shard** = *where the bytes live*. Reuse
  the #104 `shard_key(tenant, project, execution_id)` unchanged so
  state shards **co-locate with the same execution's result
  bytes** under the same `shard=sNNNN/.../execution=<eid>/` prefix.
  Locality: one prefix listing returns both an execution's results
  and its state shard.
- **Cache ownership** = *which stateful worker holds the hot
  projection*. Reuse the #116 `shard_for(execution_id)`
  (XxHash64) so the worker that **owns the drive** is the worker
  that **caches the state** — the drive request and the cache live
  on the same pod, no cross-worker round-trip on the hot path.

The two stay independent: the object layout is addressed by the
logical URN (derivable, replica-agnostic); cache ownership is a
runtime routing concern that can rebalance without moving a single
object. A worker that owns `shard_for(eid)==my_index` cold-loads
that execution's shard from whatever `s{fnv:04}` folder the locator
resolves — the FNV folder is a storage detail behind the URN.

### 3.2 Shard granularity

Shard at the **execution** grain for the cache and the object
layout, bucketed into the existing 256 folder-shards for the
physical store:

- **Cache unit** = one `ExecutionChain` (one execution's slim
  chain + cached spine). Eviction, TTL, and ownership are
  per-execution.
- **Object unit** = one **state shard object per execution**
  (§4), written under the #104 `s{fnv:04}` folder. Append-friendly
  compaction (§4.3) keeps the object count bounded.

Per-tenant fan-out is the FNV folder dimension already; no new
tenant hash is needed. A `tenant ‖ project` prefix in the URN
keeps multi-tenant isolation at the path level (matches the #104
layout and the data-access-boundary rule).

### 3.3 Rebalancing and ownership change

Cache ownership follows #116. When `NOETL_SHARD_COUNT` /
`NOETL_SHARD_INDEX` change (scale-up / scale-down), an execution's
owner moves. Because the durable truth is the object-store shard,
**rebalancing is cache-cold, not data-move**: the new owner
cold-loads the shard from the tier on its first drive request; the
old owner's cache entry simply ages out under TTL. No object is
copied, no chain is migrated over the wire. This is the structural
payoff of object-store-as-truth — ownership is a routing decision,
not a data-migration event. (Contrast today: the resident index is
the only copy, so any topology change strands or duplicates state.)

---

## 4. Feather shard schema

### 4.1 Slim chain, not full envelopes

The single biggest memory lever (§1.2) is to stop holding full
event envelopes. A shard stores the **slim chain** plus a
**reference to the bytes**, reusing the #104 result tier for the
heavy payloads.

Per-event columnar row in a shard:

| Column | Type | Source | Purpose |
| :-- | :-- | :-- | :-- |
| `event_id` | Int64 | envelope | chain node key |
| `prev_event_id` | Int64 (nullable) | envelope | the chain link the walk follows |
| `event_type` | Utf8 (dict-encoded) | envelope | genesis/terminal guard, trigger classification |
| `execution_id` | Int64 | envelope | shard routing / filter |
| `node_id` / `step` | Utf8 (dict) | envelope | spine reconstruction |
| `result_ref` | Utf8 (nullable) | envelope `reference.uri` | **#104 URN**, resolved on demand |
| `extracted` | Utf8/JSON (bounded) | envelope `extracted` block | the inline predicate block #115 keeps |
| `payload_inline` | Utf8/JSON (nullable) | envelope | only when under the inline budget |

The load-bearing change: **`from_events` consumes the slim chain +
resolves `result_ref` lazily**, instead of the verbatim full
envelope. For the drive *decision* (which arc fires next, loop
counters, fan-in barriers) the chain links + `event_type` +
bounded `extracted` block are sufficient — the same reference-only
principle #115 already established for command context. Bulk data
(tool results) is fetched by URN only when a step actually needs
the value, which on the drive path is rare.

This alone changes per-event resident cost from ~73 KiB to the
tens-of-bytes slim row + an optional bounded `extracted` snippet —
a **1–2 order-of-magnitude** reduction before any eviction policy
is considered.

### 4.2 Columnar layout

Arrow Feather/IPC via `noetl_tools::arrow_codec` (the same encoder
the result tier uses). One `RecordBatch` per execution shard,
columns as above, dictionary-encoded `event_type` / `node_id`
(low cardinality → near-free). Row order = causal spine order
(`SpineOrder::Causal`, the #117 default) so a decoded shard is
already in `from_events` order with no re-sort.

A shard is self-describing: schema in the IPC footer, no external
catalog needed to decode. This matches the "deterministic,
derivable, no carried reference" property of the #104 tier — a
reader reconstructs the object key from the URN alone.

### 4.3 Compaction strategy

A naive "one object per event" would explode object count. Instead:

- **Open shard = append batch.** While an execution is live, the
  state-shard writer (§4.4) appends new events to an in-progress
  shard object on a cadence (every N events or T seconds),
  overwriting idempotently — the same idempotent-overwrite
  contract the #104 tier already uses (§5 of the Event-WAL doc).
- **Seal on terminal.** When the terminal event lands, the writer
  seals the shard (final compacted Feather object,
  `…/state/<eid>/sealed.feather`) and the execution is removed from
  the open set.
- **Prefix GC.** Sealed shards age out under the same prefix-GC /
  tier-GC policy as result objects
  ([#104](https://github.com/noetl/ai-meta/issues/104) tiered GC;
  the durable audit truth remains `noetl.event` and the bounded
  NATS WAL, so a sealed state shard is a rebuildable cache artifact,
  GC-safe).

Object count is therefore `O(live executions)` open shards +
`O(retention-window terminal executions)` sealed shards, both
bounded, both under the existing GC machinery.

### 4.4 Reuse of the #104 tier — exact seams

From the tier audit, these parts are **directly reusable**
(generic over JSON payload):

- `noetl_tools::arrow_codec::try_encode_tabular_json` — encodes the
  slim-chain RecordBatch.
- `decide_tier()` (`result_locator.rs`) — Feather vs JSON tiering.
- `shard_key()` / cell placement (`noetl-locator`) — the FNV folder
  + `env/region/cell/shard` prefix.
- `ControlPlaneClient::object_put` / `object_get`
  (`PUT`/`GET /api/internal/objects/{key}`) — server-mediated
  store, so workers stay off direct GCS (data-access-boundary).

These parts need **a new sibling, not a rewrite** (today they are
hardwired to result coordinates `(eid, step, frame, row, attempt)`):

- A new **`StateCoordinates`** logical URI
  `noetl://<tenant>/<project>/state/<execution_id>/<seal|open>@<version>`
  parallel to the existing `…/results/…` URN, with its own
  `physical_key()` writing under
  `…/shard=sNNNN/.../execution=<eid>/state/…feather`.
- A new **state-shard writer consumer**
  (`noetl_state_materializer`) modeled on `result_materializer.rs`
  — drains `noetl_events`, batches per execution, encodes the slim
  chain, `object_put`s the shard. It is the write-side sibling of
  the existing result materializer and projector consumers (the
  "two pools drain the log" shape from #104 becomes three).

---

## 5. Worker cache + eviction model

### 5.1 The bounded cache

Replace the unbounded `HashMap<i64, ExecutionChain>` with a bounded
cache fronting the shard store:

- **LRU by execution.** Most-recently-driven executions stay hot;
  cold ones evict first.
- **TTL.** A configurable idle TTL
  (`NOETL_STATE_CACHE_TTL_SECS`) evicts an execution that hasn't
  been driven recently even if memory isn't pressured — this is the
  fix for stuck/abandoned executions (§1.3 item 2) that terminal
  eviction misses.
- **Hard byte ceiling.** `NOETL_STATE_CACHE_MAX_BYTES` — when the
  resident set would exceed it, evict LRU entries until under the
  ceiling. **This is the bounded-memory guarantee:** resident set
  ≤ ceiling, regardless of history size or live-execution count.
- **Terminal eviction stays** as the cheap fast-path (free the
  chain the instant it completes).

Memory becomes `O(min(active working set, ceiling))`.

### 5.2 Cold-load on miss (reuse #119 rehydration)

A drive request for an execution not in cache (cold start,
post-eviction, post-restart, ownership change) **cold-loads the
shard from the tier** instead of replaying the 24h WAL:

1. `build_offserver_input` finds no chain (today: `Incomplete` →
   fall back to server build).
2. **New:** resolve the `StateCoordinates` URN → `object_get` the
   Feather shard → decode → populate the cache entry.
3. Apply any WAL tail beyond the sealed shard's head from the
   bounded per-execution NATS replay (the #156 tail-attach already
   delivers a per-execution event slice on the drive command — the
   shard provides the body, the tail provides the last few events).
4. Advance to `expected_head`, return the spine.

This **reframes the #119 rehydration**: the post-restart
"rebuild the index from the retained WAL" path becomes
"cold-load the shards you're asked to drive, on demand" — the boot
no longer materializes the whole 24h window, it materializes
nothing until the first drive request, then one shard per
requested execution.

### 5.3 Projection maintenance

The cached `ExecutionChain` keeps its existing incremental cache
(`AdvanceOutcome::CacheHit / Incremental / ColdRebuild`). The shard
store + the #156 tail keep the cache warm:

- **Cache hit / incremental** — steady-state hop, in-memory, the
  #130/#156 fast path is unchanged.
- **Cold rebuild** — now bounded: re-decode the shard, not re-walk
  the whole index.
- The state-shard writer keeps open shards current so a
  post-eviction cold-load is recent (small tail to apply).

---

## 6. Stateful vs stateless worker roles

Two roles on one binary, selected by config — no new image:

- **Stateless executors** (the step pools) stay pure: claim a
  block, run a tool, emit events, release. No state index. (Today's
  step-pool worker is already this — ~9 MiB.)
- **Stateful builders** (the system pool, and any future
  drive-replica pool) advertise ownership of a shard range
  (`shard_for(execution_id) ∈ owned set`), hold the bounded cache,
  and answer `__offserver_build__` for executions they own.

### 6.1 Ownership advertisement & routing

Reuse #116 execution-affinity. Each stateful worker is configured
with `NOETL_SHARD_INDEX` / `NOETL_SHARD_COUNT`; the server's drive
dispatch routes `__offserver_build__` for an execution to the
worker owning `shard_for(execution_id)` (the NATS subject /
consumer is already the routing seam — the command goes to the
owning consumer group). A non-owning worker that receives a build
request forwards or declines (the #116 forward/redirect pattern,
applied to the worker side).

### 6.2 Failover when an owner dies

Because the shard is durable in object store, failover is a
**cold-load, not a state-transfer**:

1. Owner pod dies → its bounded cache is lost (it was only a
   cache).
2. The drive request re-routes (KEDA/replica reassignment changes
   the owned shard set, or a standby owns the range).
3. The new owner cold-loads the shard from the tier (§5.2) on the
   first request and continues.

No state is stranded (the #163/#161 wedge class — a single resident
copy that dies with the pod — is structurally eliminated). The
#163 self-heal + `/livez` backstop remain as the liveness floor;
this RFC removes the *reason* a wedge is catastrophic (lost state),
self-heal handles the *transient* (lost consumer).

### 6.3 Worker-to-worker projection exchange

The user's proposed peer-to-peer exchange. Honest assessment:
**make it optional and second-phase.** With object-store-as-truth
and execution-affinity routing, the common case needs **no direct
worker-to-worker transfer** — a worker that needs a shard it
doesn't own reads it from the tier, the shared source of truth.
Direct P2P is an optimization for one case: handing a *warm* cache
entry to a new owner on a planned rebalance to skip the cold-load.

If pursued:

- **What they exchange:** a serialized warm `ExecutionChain`
  (slim chain + cached spine) for executions whose ownership is
  moving — not arbitrary cross-talk.
- **Transport:** reuse NATS request/reply (the worker already holds
  a JetStream/core NATS client; a `state.handoff.<shard>` subject
  keeps it on the existing bus, no new mesh). Bounded by the same
  payload caps as commands.
- **Consistency model:** the handoff is **advisory cache warming
  only** — the receiver treats it as a hint and still trusts the
  shard store + WAL tail as truth (the same "signal is a liveness
  hint, the index under the mutex is the source of truth" contract
  the #130 append-notify already uses). A stale or dropped handoff
  costs a cold-load, never correctness.

Recommendation: **ship object-store-as-truth + affinity routing
first; treat P2P warm-handoff as a later latency optimization, not
a correctness mechanism.** The honest tradeoff is in §9.

---

## 7. Consistency + correctness

The change is a **caching/storage substrate swap**, not a change to
the write model. The CQRS guarantees hold:

- **Sole-writer (#103).** `noetl.event` is still written only by
  the materializer consumer. The state-shard writer is a **third
  read-model projector** off the same WAL — it writes Feather
  shards (a derived artifact), never `noetl.*` tables. It composes
  with the materializer exactly like the projector does: independent
  durable consumer, idempotent fold by `event_id`.
- **Ordering (#117).** Shards store the causal spine
  (`SpineOrder::Causal`); the cold-load decodes in causal order.
  The #117 fan-out inversion fix is preserved because the shard is
  written from the same chain walk.
- **Per-hop state (#156).** The drive still advances to the
  server's `expected_head` (`ChainHeads` watermark) and the
  `advance_to` staleness guard still returns `Incomplete` until the
  tip is indexed — so WAL-built state is never staler than the
  server's view. The cold-load + bounded tail provide the body;
  the global-scan is never reintroduced.
- **Never-scan invariant (#115).** Cache hit, cold-load, and tail
  apply all read the WAL / the Feather shard — never `noetl.event`.
- **Crash recovery (#104 / #119).** Resume reads the sealed/open
  shard + replays the local WAL tail past the shard head. Dedup of
  non-idempotent work stays keyed on URN existence (the #104
  side-effect barrier), unchanged.
- **Multi-replica write ordering (#116).** Execution-affinity
  routing already guarantees one owner per execution's drive +
  chain write; the state shard inherits single-owner write
  ordering from the same routing.

The one genuinely new consistency question: **open-shard freshness
vs the WAL tip.** A cold-load gets the last sealed/appended shard +
the WAL tail; if the writer's append cadence lags, the tail is
longer. This is bounded by the writer cadence (§4.3) and is
identical in shape to today's "worker WAL drain lags the server"
gap that `advance_to` already handles by returning `Incomplete` and
falling back. No new failure mode — same guard, different body
source.

---

## 8. Migration path

Incremental, each phase independently shippable and reversible,
flag-gated, no big-bang. **Phase 1 is the memory relief; Phases
2–5 are the full object-store model.**

### Phase 1 — bound the existing index (biggest relief, soonest)

**LRU + TTL + byte-ceiling eviction on the current
`WalEventIndex`, with cold-rebuild-on-miss from the retained WAL.**
No object store, no new consumer — purely a bound on the existing
structure plus a slim-chain option.

- Add `NOETL_STATE_CACHE_MAX_BYTES`, `NOETL_STATE_CACHE_TTL_SECS`,
  `NOETL_STATE_CACHE_MAX_EXECUTIONS` (all default to "unbounded" =
  today's behavior, so the change is behavior-neutral until set).
- Evict LRU/TTL beyond terminal eviction. On a drive miss for an
  evicted execution, rebuild from the bounded per-execution WAL
  replay (the #156 tail already scopes this) instead of falling
  back to the server.
- **Optional sub-step:** stop cloning the full envelope into
  `IndexedEvent::raw`; keep the slim chain + a lazy
  re-fetch-by-URN for the body. This is the single highest-leverage
  memory change and can land independently.
- **Repos:** `worker` only. **Reversible:** unset the env vars.
- **Effect:** caps resident memory immediately; converts the OOM
  treadmill into a bounded cache with a measured hit rate. This is
  the bridge that de-risks everything after it.

### Phase 2 — state-shard writer (shadow)

Add the `noetl_state_materializer` consumer (sibling of
`result_materializer`) writing Feather state shards to the #104
tier, **off the drive path** (shadow). Define `StateCoordinates`
URN + `physical_key`. Default off
(`NOETL_STATE_SHARD_WRITER`). Validate shards are written +
decodable on kind; the drive still uses the Phase-1 bounded cache.

- **Repos:** `worker`, `tools` (locator), `server` (object key
  routing already exists). **Reversible:** flag off.

### Phase 3 — cold-load from shards on cache miss

Wire the Phase-1 cold-rebuild path to prefer the Phase-2 Feather
shard over a WAL replay
(`NOETL_STATE_CACHE_COLD_SOURCE=shard|wal`). On miss: `object_get`
the shard → decode → apply WAL tail → advance. WAL replay stays as
the fallback when no shard exists yet.

- **Repos:** `worker`. **Reversible:** `…COLD_SOURCE=wal`.
- **Effect:** restart no longer replays 24h of WAL; boot is lazy.

### Phase 4 — execution-affinity for the state cache

Apply #116 routing to the build dispatch so each stateful worker
owns + caches a shard range. Enables >1 drive replica without fork
(the #116 acceptance rig already validates this for the chain;
extend it to assert per-owner cache locality).

- **Repos:** `server` (routing), `worker`, `ops` (shard env on the
  pool), `e2e` (extend `kind_validate_replica_coherence.sh`).
  **Reversible:** `NOETL_SHARD_COUNT=1` (single owner = today).

### Phase 5 — (optional) P2P warm-handoff + GC integration

Warm-cache handoff on planned rebalance (§6.3) and fold sealed
shards into the #104 prefix-GC. Latency optimization + housekeeping;
not required for correctness or the memory fix.

- **Repos:** `worker`, `ops`. **Reversible:** flag off (falls back
  to cold-load).

**Reuse map:** Phase 1 reuses the existing index + #156 tail.
Phases 2–3 reuse `arrow_codec`, `decide_tier`, `object_put/get`,
`shard_key` (the entire #104 write/resolve plumbing). Phase 4
reuses `sharding.rs` `shard_for`/`owns` and the #116 rig. Only the
`StateCoordinates` URN + the state-materializer consumer are net-new
code, and both are siblings of existing, tested components.

---

## 9. Tradeoffs / risks (honest)

- **Object-store latency on cache miss.** Today every drive hop is
  all-in-memory (when warm). A cold miss now pays a
  `GET /api/internal/objects/{key}` + Feather decode (tens of ms on
  GCS, plus the server hop). **Mitigation:** the working set is
  cached, so steady-state hops are unaffected; misses are
  first-touch / post-eviction / failover only. **Risk:** a
  pathological access pattern (many distinct executions, each
  driven once, cache thrashing) pays a miss per hop. The byte
  ceiling must be sized so the *concurrent* working set fits; if it
  can't, the answer is more stateful replicas (shard the cache),
  not a bigger single cache. Phase 1's measured hit rate tells us
  whether this is real before we commit to the object path.

- **Cold-start behavior.** Lazy cold-load (§5.2) is strictly better
  than today's full-WAL replay for *time-to-first-drive*, but the
  *first* drive of each execution after a restart pays a miss. For
  a pool restarted under load, that's a miss storm. **Mitigation:**
  optional warm-up of the N most-recently-active open shards on
  boot (bounded, not the whole window); P2P handoff (Phase 5) on
  *planned* restarts.

- **Cross-worker coordination cost.** Execution-affinity routing
  adds a routing decision and the possibility of a forward/redirect
  for a misrouted request. The #116 work already pays most of this;
  the state cache rides the same routing. P2P handoff (Phase 5)
  adds NATS traffic — kept advisory and bounded so it can't become
  a coordination bottleneck.

- **Where it could regress #156/#130 latency.** The whole point of
  #130/#156 was to get the per-hop floor *down*. A poorly-sized
  cache or a slow object store could push cold misses back up toward
  the multi-second range #130 fought. **This is the central risk
  and the reason Phase 1 ships first:** it gives us the hit-rate and
  miss-cost numbers on the *existing* in-memory structure (cold
  miss = bounded WAL replay, no object store) before we add
  object-store latency to the miss path. We only proceed to Phases
  2–3 if Phase 1 shows the working set is small and stable. If
  Phase 1 shows a large, churny working set, the object-store miss
  cost would be a regression and the design must shard the cache
  across more replicas (Phase 4) *before* leaning on cold-load.

- **Writer lag / open-shard freshness.** The state-shard writer is
  another consumer competing for the same single system-pool
  replica's cycles (the #130 serialization concern). **Mitigation:**
  the writer runs on its own consumer and, post-Phase-4, can run on
  a dedicated pool; the `advance_to` `Incomplete` guard means a
  lagging writer degrades to a longer WAL-tail apply, never
  incorrect state.

- **New code surface.** A new URN type + a new consumer is new
  attack surface for bugs. **Mitigation:** both are siblings of
  tested components (`result_materializer`, the result locator);
  the shadow phase (Phase 2) validates them off the drive path
  before they're load-bearing.

---

## 10. Recommended Phase 1

**Ship LRU + TTL + byte-ceiling eviction on the existing
`WalEventIndex`, plus the slim-chain (drop the full-envelope clone),
with cold-rebuild-on-miss from the bounded per-execution WAL replay.**

Why this first:

1. **Biggest memory relief, soonest, lowest risk.** It caps
   resident memory to a configured ceiling *immediately* — the OOM
   treadmill ends in one worker-only change, no object store, no new
   consumer, no routing change.
2. **The slim-chain sub-step alone** (stop cloning the full envelope
   into `IndexedEvent::raw`, keep slim links + lazy URN re-fetch) is
   ~99% of the footprint per §1.2 — a 1–2 order-of-magnitude
   reduction before eviction policy even engages.
3. **It is the measurement that de-risks the rest.** Phase 1's
   cache hit-rate + miss-cost (against an in-memory/WAL miss, no
   object latency) is exactly the data needed to decide whether the
   object-store model (Phases 2–3) helps or regresses #156/#130. We
   do not commit object-store latency to the hot path on a guess.
4. **Fully reversible** — every knob defaults to today's unbounded
   behavior; setting `NOETL_STATE_CACHE_MAX_BYTES` turns the bound
   on, unsetting it reverts.

Phase 1 is the bridge: it makes the system safe *now* and produces
the evidence that tells us how far down the object-store path to
walk. Phases 2–5 are the durable end-state; Phase 1 is the thing to
build first.

---

## Related

- [Event WAL and Derivable Result Storage](./event_wal_and_derivable_storage.md)
  — the #104 Feather tier this extends from result bytes to state
  shards.
- [Ephemeral Blueprints](./ephemeral_blueprints.md) — the
  compute/data boundary (workers = atomic compute, state in the
  cache + log) this honors.
- [CQRS Write-Path Cutover](./cqrs_write_path_cutover.md) — the
  sole-writer model (#103) this composes with.
- Umbrella issues:
  [#104](https://github.com/noetl/ai-meta/issues/104),
  [#115](https://github.com/noetl/ai-meta/issues/115),
  [#116](https://github.com/noetl/ai-meta/issues/116),
  [#130](https://github.com/noetl/ai-meta/issues/130),
  [#156](https://github.com/noetl/ai-meta/issues/156),
  [#163](https://github.com/noetl/ai-meta/issues/163).
