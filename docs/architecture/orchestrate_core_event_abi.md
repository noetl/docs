---
id: orchestrate_core_event_abi
title: Orchestrate-Core Event ABI
sidebar_label: Orchestrate-Core Event ABI
sidebar_position: 11
---

# Orchestrate-Core Event ABI

**Status:** Design for the Event-ABI round of the orchestrator-as-plug-in work
([noetl/ai-meta#108](https://github.com/noetl/ai-meta/issues/108), under the
[Server Dissolution](./noetl_server_dissolution_and_global_grid.md) program).
The renderer, playbook model, command builders, and condition evaluator already
compile to both native and `wasm32-unknown-unknown` from `noetl-orchestrate-core`.
The last two modules — `state` and `orchestrator`/`evaluate` — consume the event
log, and the event type is the one thing that can't follow them as-is.

## The boundary is unavoidable, and that's the point

`db::Event` is `sqlx::FromRow` — native-only. A db-free, wasm-safe core type can
never be `FromRow`, so it can never be `query_as`'d. Therefore a
**`db-row → core-event` conversion exists no matter what** — the only question is
whether the core event is *the single event shape everywhere* (a system-wide
refactor) or *the read-shape at one boundary* (this round). The conversion is the
same and cheap either way; the system-wide unification buys nothing on the
boundary and pre-empts the WAL event-shape design. So we take the boundary.

## The core event type

The drive reads a clean subset of `db::Event` — never the DB-only fields (`id`
serial, `catalog_id`, `parent_event_id`, `node_id`, `node_type`, `worker_id`):

```rust
// noetl-orchestrate-core::event — pure, wasm-safe (chrono + serde_json, no sqlx)
pub struct Event {
    pub event_id: i64,             // snowflake — ordering
    pub execution_id: i64,
    pub event_type: String,
    pub node_name: Option<String>,
    pub status: String,
    pub context: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub meta: Option<serde_json::Value>,
    #[serde(alias = "created_at")]
    pub timestamp: DateTime<Utc>,  // event-sourced, never now()
    pub parent_execution_id: Option<i64>,
    pub attempt: Option<i32>,
}
```

**Named to converge.** The field set deliberately mirrors `EventEnvelope` (the
CQRS materializer's shape — already `event_id`/`execution_id`/`event_type`/
`node_name`/`status`/`context`/`result`/`timestamp`), and it lives under the
canonical name `core::event::Event`. So when [#104](https://github.com/noetl/ai-meta/issues/104)
makes the JetStream WAL record the system's one true event, this isn't a fourth
shape to reconcile — it's the seed to **promote to the WAL event**. The
unification rides #104; it is explicitly *not* this round.

## The conversion

- **Server:** `impl From<&db::Event> for core::event::Event` — a field copy. The
  `context`/`result` `Value`s are cloned, but references-in-state +
  block-b bounding already keep them small (events carry `noetl://` references,
  not bulk payloads), so the clone is cheap. `db::Event` and its 8 `query_as`
  sites are untouched.
- **In-process path (now):** `trigger_orchestrator` loads `db::Event`s → maps to
  `Vec<core::event::Event>` → calls `evaluate`. One bounded map per drive.
- **Plug-in path (later):** the bounded slice serializes over the
  [#105](https://github.com/noetl/ai-meta/issues/105) data-plane ABI —
  serde_json/CBOR bytes first, Arrow columnar when it pays. Bounded slice +
  refs-not-bulk keep it small.

## Determinism — what earns the shadow-diff

The plug-in cutover is gated by a **shadow-diff**: run the plug-in alongside the
in-process orchestrator and compare emitted commands. For that to mean anything,
`evaluate` must be a pure function of `(events, playbook)` **up to generated
ids**. The drive today has ~11 `Utc::now()` calls (3 state fallbacks, 8
orchestrator) plus HashMap iteration. The round's audit:

1. **Timestamps come from events, never `now()`.** The `created_at`-unreadable
   fallbacks become hard errors or are event-sourced.
2. **Ordering is deterministic.** HashMap iteration that feeds command ordering
   becomes `BTreeMap`/sorted — also a correctness win.
3. **The diff compares content, not generated ids.** Two runs legitimately mint
   different `command_id`/timestamps; the shadow-diff compares
   `(execution_id, step, tool_kind, rendered input/context)` and normalizes the
   freshly-generated ids.

## The slices

1. **`core::event::Event` + `From<db::Event>` + the determinism audit** — define
   the type, the boundary conversion, and make the drive event-sourced/ordered.
   `state`/`orchestrator` keep using `db::Event` until they move; this slice is
   additive + green.
2. **Move `state`** (`WorkflowState`) into the core — switch it to
   `core::event::Event`.
3. **Move `orchestrator`/`evaluate`** into the core — the top; it now has every
   dependency (renderer, model, commands, evaluator, state, event) in the core.
4. Then the plug-in: the data-plane ABI + a `command_emit` host capability + the
   kernel scheduler + the shadow-diff → the live `system/orchestrate` plug-in.

## Related

- [Server Dissolution and the Global Grid](./noetl_server_dissolution_and_global_grid.md) — the program; this is step 2's last mile.
- [CQRS Write-Path Cutover](./cqrs_write_path_cutover.md) + [Event WAL](./event_wal_and_derivable_storage.md) — where the canonical event (the WAL record) gets designed; this event type is its seed.
- [System Pool + WASM Plug-ins](./system_pool_and_wasm_plugins.md) — the data-plane ABI + capability ring the plug-in uses.
