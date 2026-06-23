---
id: system_pool_and_wasm_plugins
title: System Worker Pool and WASM Plug-in Surface
sidebar_label: System Pool & WASM Plug-ins
sidebar_position: 8
---

# System Worker Pool and WASM Plug-in Surface

**Status:** Design ADR — tracked under
[noetl/ai-meta#46][issue-46] (primary migration umbrella).
[noetl/ai-meta#30][issue-30] (Appendix H worker migration) and
[noetl/ai-meta#45][issue-45] (originally-proposed compiled
rewrite of publisher + projector + server) both closed
2026-06-02 in favour of the system-playbook approach captured
here.  Not yet implemented.

**Revision history:**
- **v1** 2026-06-02 — initial ADR; publisher + projector
  classified as "compiled core" alongside HTTP routing.
- **v2** 2026-06-02 — revised: publisher + projector
  reclassified as **plug-in ring** (system playbooks).
  The compiled core shrinks to HTTP routing + dispatch.
  See the "Revised classification (2026-06-02 v2)" section
  below for the rationale.

[issue-30]: https://github.com/noetl/ai-meta/issues/30

For the higher-level shape this design extends, see
[Ephemeral Blueprints and the Compute-Data Boundary](./ephemeral_blueprints.md).

[issue-45]: https://github.com/noetl/ai-meta/issues/45
[issue-46]: https://github.com/noetl/ai-meta/issues/46

## Implementation status (2026-06-02)

The first three phases land — system worker pool runtime is live on
kind, server API endpoints are kind-validated, first system playbook
is registered:

```
+----------------------------------------------------------------+
|                                                                |
|  Phase 1.a — server /api/internal/* endpoints       ✅ shipped |
|     Python (noetl v4.10.1) ✅ kind-validated                   |
|     Rust   (server v2.1.1) ✅ unit-tested                      |
|                                                                |
|  Phase 1.b — system worker pool deployment          ✅ shipped |
|     noetl-worker-system-pool deployed + idle on                |
|     noetl_worker_pool_system NATS consumer                     |
|     KEDA ScaledObject READY                                    |
|                                                                |
|  Phase 2.a.1 — system/outbox_publisher.yaml         ✅ shipped |
|     Playbook in noetl/ops playbooks/system/ namespace          |
|     Uses tool: http (claim/mark) + tool: nats (publish)        |
|     Auth via bearer token from keychain alias                  |
|                                                                |
|  Phase 2.a.2 — server-side system/* routing         ⏳ pending |
|     Last piece before end-to-end kind validation possible      |
|                                                                |
|  Phase 2.a.3 — deployment env wiring                ⏳ in PR   |
|     NOETL_KEYCHAIN_ENV_VARS=NOETL_INTERNAL_API_TOKEN            |
|     (noetl/ops#143 — configuration-only, no Rust code)          |
|                                                                |
|  Phase 2.b — system/projector.yaml                  ⏳ blocked |
|  Phase 3 — auth, RBAC, scheduled cleanup playbooks  ⏳ later   |
|  Phase 4 — WASM compilation                         ⏳ later   |
|                                                                |
+----------------------------------------------------------------+
```

Key discovery during implementation: **Phase 2.a.3 (bearer-token
auth wiring) is configuration-only**.  The original estimate was
2-3 hours of Rust work to extend the worker's keychain.  In reality
the worker already supports a comma-separated env-var allow-list
(``NOETL_KEYCHAIN_ENV_VARS``) that lifts env values into
``ctx.secrets`` verbatim.  One Deployment-env line + the standard
``auth: { type: bearer, credential: <alias> }`` block in the
playbook completes the wiring.  No new code paths.  This is
exactly the "platform extends itself with its own primitives"
property the ADR aims for — bearer-token auth for system
playbooks falls out of existing pieces.

For the running detail of what's open / blocked / merged, see the
ai-meta wiki dashboard:
[Umbrella: System Pool Design](https://github.com/noetl/ai-meta/wiki/Umbrella-System-Pool-Design).

## The problem

After the Rust worker migration ([Appendix H][appendix-h] of the
hybrid-cloud blueprint), the runtime still has three Python pods
in the active path:

| Pod | Module | Function |
|---|---|---|
| `noetl-server` | FastAPI / uvicorn | HTTP control plane |
| `noetl-outbox-publisher` | `python -m noetl.outbox_publisher` | Postgres outbox tailer → NATS |
| `noetl-projector-0` | `python -m noetl.projector` | NATS event stream → Postgres event log |

A naive Rust rewrite ports each to a separate Rust binary.  The
proposal here is more interesting: introduce a **system worker
pool** that runs platform-internal logic as NoETL playbooks under
a `system/` namespace, and use **WASM** as the plug-in compilation
target for hot reload.

Model analogy: Oracle's `SYS` schema (privileged namespace,
platform extends itself with its own primitives) plus PostgreSQL
extensions (`CREATE EXTENSION` loads compiled code at runtime
via `dlopen`).

[appendix-h]: ./noetl_global_hybrid_cloud_grid_distributed_architecture_blueprint.md#h-rust-migration-path-and-unified-executor-roadmap

## Data access boundary — server API only for NoETL-owned data

A foundational rule that shapes every system playbook below:

> **NoETL platform data is accessible via the NoETL server API
> only.**  Workers — including the system worker pool — call
> the server's HTTP API for any read or write to NoETL-owned
> tables (`noetl.event`, `noetl.command`, `noetl.execution`,
> `noetl.outbox`, `noetl.catalog`, `noetl.credential`, etc.).

**Why** (full rationale in
[`agents/rules/data-access-boundary.md`](https://github.com/noetl/ai-meta/blob/main/agents/rules/data-access-boundary.md)):

1. **Connection pool isolation.**  Workers scale 1→50+ on
   backlog.  If each holds a Postgres connection from the
   platform pool, the math collapses: server can't acquire a
   connection for its own API, deadlock cascades.
2. **Sharding readiness.**  Future: noetl-server runs N shards,
   each owning a slice of executions.  Workers calling the API
   means shard routing is transparent; workers hitting DB
   directly locks sharding out.
3. **Single point of consistency.**  Schema migrations, audit
   logging, RBAC, response-boundary credential scrubbing — all
   enforced at the server.  Distributing across workers ≈
   re-implementing the server in each worker.

**The exception** is **external-subsystem playbooks** that
integrate NoETL with Auth0 / Okta / Vault / PagerDuty / Slack /
etc.  Those go direct because the target isn't NoETL data, it's
an external system.  `system/auth`, `system/credential_rotate`,
`system/notify_alert` are external-subsystem playbooks; they
use `tool: http` / `tool: postgres` directly.  `system/outbox_publisher`,
`system/projector`, `system/scheduled_cleanup` are
NoETL-state playbooks; they use the server API.

### What this requires from the server

The Python server's API surface today doesn't have endpoints
for the operations the system pool's playbooks need.  These
get added as part of the system-pool migration:

| New internal endpoint | What it does | Replaces direct DB access by |
|---|---|---|
| `POST /api/internal/outbox/claim?limit=N` | `SELECT ... FOR UPDATE SKIP LOCKED`, mark IN_FLIGHT, return rows | Python `claim_outbox_batch` |
| `POST /api/internal/outbox/mark-published` | Batch `UPDATE status=PUBLISHED` | Python `mark_outbox_published` |
| `POST /api/internal/outbox/mark-failed` | Batch `UPDATE status=FAILED` with exponential backoff | Python `mark_outbox_failed` |
| `GET /api/internal/outbox/pending-count` | Count of `PENDING`/`FAILED` rows (KEDA scaler source for the system pool) | (new) |
| `POST /api/internal/events/project` | Batch `INSERT INTO noetl.event` with `ON CONFLICT DO NOTHING` | Python projector batch INSERT |
| `POST /api/internal/cleanup/sweep` | TTL-based cleanup of stale rows | Python cleanup jobs (when they exist) |

Auth: gated by a service-account token only the system worker
pool's K8s ServiceAccount carries (`noetl-worker-system-pool`).
User playbooks calling `/api/internal/*` get 403.

Per [`observability.md`](https://github.com/noetl/ai-meta/blob/main/agents/rules/observability.md)
Principle 1, each endpoint ships with its span + metric +
`execution_id` correlation in the same change set.

## The split — compiled core vs. plug-in ring

The shape that emerged from the 2026-06-02 design discussion
(and was corrected later the same day — see "Revised
classification" below):

### Compiled core (stays in Rust)

Things that don't fit the playbook abstraction or that gate
every request:

- **HTTP route table + middleware** — `/api/catalog/*`,
  `/api/execute`, `/api/events`, SSE.  The router itself stays
  compiled; customisable bits inside route handlers (auth check,
  RBAC) call into the plug-in ring.
- **Execution-id resolution + dispatch fan-out** — the inner
  loop of `_handle_event_inner` and the command-to-NATS publish
  path.  Sub-millisecond budget per request.
- **Tool registry** (`noetl/tools` crate) — the 14 built-in
  tool kinds (http, postgres, duckdb, ...).  These are what
  playbooks (including system playbooks) compose.
- **Worker binary** (`noetl/worker`) — the NATS pull loop,
  tool dispatch, event emission.  **Same binary serves user
  pools and the system worker pool**; the difference is
  configuration (NATS consumer + filter subject + capability
  set), not code.
- **Scrub** (`scrub::scrub_in_place`) — response-boundary
  credential redaction.  Called on every response.

### Plug-in ring (system playbooks, dispatched on `worker-system-pool`)

Everything else.  Including the things you'd expect to be hot
loops:

- **`system/outbox_publisher`** — replaces today's
  `python -m noetl.outbox_publisher` Python pod.  Uses
  `tool: postgres` (claim + mark) + `tool: nats` (publish).
  Iteration scheduled by polling cron / KEDA-on-outbox-depth.
- **`system/projector`** — replaces today's `python -m noetl.projector`
  pod.  Uses `tool: nats` (subscribe) + `tool: postgres` (batch
  INSERT).  Sharded via worker_id; one playbook execution per
  shard.
- **`system/auth`** — session validation, token lookup, IdP
  integration.  Tenants can override with
  `<tenant>/system/auth_with_saml`.
- **`system/rbac`** — per-action authorisation.  Tenant-
  overridable.
- **`system/scheduled_cleanup`** — TTL enforcement, stale-row
  reaping.
- **`system/credential_rotate`** — refresh long-lived tokens
  before expiry.

The compiled core is **small and stable** — HTTP routing,
dispatch, the tool registry, the worker binary, scrub.  The
plug-in ring is **everywhere extension happens** — including
the things that used to be standalone Python services.  Matches
the "kernel + modules" pattern, but the modules are NoETL
playbooks instead of Linux kernel modules.

### Revised classification (2026-06-02 v2)

The first version of this ADR put outbox publisher + projector
in the compiled core, arguing that throughput would suffer from
playbook-dispatch overhead.  That reasoning was wrong:

- **Publisher**: fires per outbox **batch**, not per row.  A
  batch is 100 events by default.  Playbook dispatch is ~1ms;
  amortised over 100 events that's 10µs/event — invisible vs.
  the network publish.
- **Projector**: fires per NATS **batch**, not per event.  Same
  amortisation argument.  Plus the projector benefits from
  audit + replay semantics that playbooks have natively.
- **Pluggability matters**: even system services want override
  capability (tenant-specific publishers, custom projectors for
  multi-region fan-out).  Forcing them as compiled code denies
  that future.

So in v2 the compiled core shrinks to **request gating + dispatch
+ scrub + tool registry + the worker binary itself**.  Everything
else lives as a playbook.  WASM compilation (Section "WASM as the
plug-in compilation target") makes the perf argument moot for
the playbooks that need it.

## The system worker pool

A new worker pool, `worker-system-pool`, sits alongside the
existing `worker-cpu-01` (Python) and `worker-rust-pool` (Rust).

```
┌──────────────────────────────────────────────────────────────────┐
│                    NoETL Cluster                                 │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐ ┌──────────────────┐  │
│  │ worker-cpu-01   │  │ worker-rust-pool │ │ worker-system-   │  │
│  │ (Python)        │  │ (Rust)           │ │   pool (Rust +   │  │
│  │ kind=agent      │  │ kind=python,     │ │ wasmtime host)   │  │
│  │ noetl_worker_   │  │      http,       │ │ kind=system_*    │  │
│  │   pool_python   │  │      duckdb, ... │ │ noetl_worker_    │  │
│  │                 │  │ noetl_worker_    │ │   pool_system    │  │
│  │                 │  │   pool_shared    │ │                  │  │
│  └─────────────────┘  └──────────────────┘ └──────────────────┘  │
│         ▲                     ▲                    ▲             │
│         └─────────────────────┴────────────────────┘             │
│                                                                  │
│                  NATS JetStream NOETL_COMMANDS                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Routing extension

`POOL_FILTER_MAP` gains a `system_*` family:

```rust
// pseudocode
pub const POOL_FILTER_MAP: &[(&str, &str)] = &[
    ("agent",         "python"),    // Python-only tool kinds
    ("system_auth",   "system"),    // System pool
    ("system_rbac",   "system"),
    ("system_cleanup","system"),
    // ... everything else falls through to "shared"
];
```

A tool kind starting with `system_` routes to
`noetl_worker_pool_system` (filter subject
`noetl.commands.system.>`).  Server-side validation ensures only
catalog entries under the `system/` path may declare `system_*`
tool kinds — preventing user playbooks from impersonating system
playbooks.

### Privilege separation

The system pool's WASM host grants a **wider capability set** than
user-tenant pools:

| Capability | User pool | System pool |
|---|---|---|
| `put_event` | Yes (own execution) | Yes (any execution) |
| `get_credential` (own scope) | Yes | Yes |
| `query_pg` (read) | No | Yes |
| `query_pg` (write) | No | Yes (with audit) |
| `read_event_log` | No | Yes |
| `mutate_catalog` | No | Yes |
| `system_call` (kernel-like) | No | Yes |

Tenant-supplied overrides (e.g. `acme/system/auth_with_saml`)
run on the system pool **but with a tenant-scoped capability
set** — they get `put_event`, `get_credential` for their tenant,
but not write access to `noetl.event` or catalog.

## Bootstrap circular-dependency resolution

If the projector is itself a playbook, but the projector writes
events that need projecting... the system pool's own events
depend on the projector running.  Same shape as a database
needing its own catalog to read its catalog.

**Three resolution options:**

### Option A — Two-tier event log (chosen)

System events flow through a compiled-in fast projector (in the
server crate); user events flow through the playbook projector
(if/when one exists).  This is **the leading option** because:

- The fast projector stays compiled anyway (per the compiled-core
  cut above), so the bootstrap is free.
- The playbook projector is a future option, not a present need.
  The plug-in surface starts with **non-projector services**
  (auth, RBAC, scheduled cleanup) where the bootstrap problem
  doesn't exist.

### Option B — Seed projector

A tiny compiled-in projector handles only its own events (cycle
of one); the full playbook projector handles everything else.
More moving parts; not needed if Option A holds.

### Option C — Privileged bypass

System-playbook events carry a `system: true` flag that the
compiled projector handles directly, bypassing the playbook
projector.  Loses the "everything goes through the same path"
property; not preferred.

## WASM as the plug-in compilation target

Rust does **not** have first-class hot module reload like Erlang's
`code:load_file/1`.  WASM via `wasmtime` (or `wasmer`) gives the
closest fit.

### Trade-off matrix

| Approach | Hot reload | Isolation | Performance | Reload safety | Fit |
|---|---|---|---|---|---|
| `libloading` (.so / .dylib) | Yes | Same process; full Rust types | Native | Fragile — pointer invalidation, UB across DSO boundary | Use only if other paths fail |
| **WASM (wasmtime)** | Yes, clean swap | Sandbox per module; capability-based imports | ~2-5× native; closer with Cranelift | Strong — module instance dropped, new one instantiated | **Leading candidate** |
| Sub-process exec | Yes — restart child | Process boundary | Fork/exec overhead per dispatch (~10-50ms) | Fully safe — OS-enforced | Cold loops only |
| YAML → in-process closure JIT | Re-register only | Same process | Native after compile | Same as libloading | Fastest if hot-reload-across-restart not needed |

### Why WASM wins

- **Already in the model.** NoETL has a `wasm` tool kind concept
  in Appendix H thinking.  Promoting it to "the plug-in mechanism
  for system playbooks" is a small conceptual step, large
  practical leverage.
- **Reload is trivial.** Catalog version bump → workers cache by
  `(path, version, digest)` → next claim invalidates and reloads.
  No process restart, no DSO juggling, no closure-borrow
  gymnastics.
- **Capability-based imports.** System WASM modules see only
  the host functions you grant.  This is exactly what
  `wasmtime`'s `Linker` API supports.
- **Cross-platform.** Same `.wasm` runs on amd64 + arm64 + GKE
  Linux without per-arch compilation — solves the multi-arch
  publishing headache from
  [noetl/ai-meta#44](https://github.com/noetl/ai-meta/issues/44)
  for the plug-in ring.

### Why NOT WASM for hot loops

- Projector batch throughput (thousands of events/sec) — WASM's
  2-5× overhead and cross-boundary memory copies are real cost.
- Publisher's tight LISTEN/NOTIFY loop — no extensibility need;
  WASM's startup cost per invocation isn't earned.
- Server HTTP routing — established compiled routing (axum /
  tower); the plug-in surface should be the route handlers'
  **bodies** for customisable routes, not the routing itself.

### Compile target and the capability boundary

Real plug-ins compile to **`wasm32-wasip1` / `wasm32-wasip2`** (not bare
`wasm32-unknown-unknown`) so Rust `std` and the Apache Arrow crates —
which support these targets — build inside the module.

But targeting WASI does **not** mean granting WASI's file / network /
env APIs. That would let a plug-in open its own socket to GCS or write a
file directly, bypassing the server boundary and violating
[the data-access boundary](https://github.com/noetl/noetl/blob/main/agents/rules/data-access-boundary.md).
Instead:

- The granted surface is **NoETL host functions registered on the
  `wasmtime` `Linker`** — `noetl.event_publish`, `noetl.result_put`,
  `noetl.object_put`, etc. The host implements the actual write, so
  placement, scrub, audit, and RBAC stay enforced. An import the host did
  not register fails `instantiate`, so the capability ring is structural.
- **WASI is limited to the pure subset** (clock, random) or stubbed.
  No `fd_*` filesystem, no `sock_*` networking. A plug-in reaches the
  outside world only through NoETL capabilities.

### Data plane — Arrow across the boundary, no serialization

The cost WASM adds is copying complex data across the boundary. For a
data runtime that is the whole game, so plug-ins move **Apache Arrow IPC
/ Feather buffers** through linear memory rather than JSON:

1. the module exports an allocator (`alloc(size) -> ptr`);
2. the host calls it for an isolated block (never writes to an arbitrary
   offset), copies the Arrow buffer straight into the module's linear
   memory, and invokes `run(ptr, len) -> packed(out_ptr << 32 | out_len)`;
3. the plug-in reads the Arrow buffers **in place** via pointers +
   lengths — no encode / decode — and writes its output buffer back.

The buffer is the same Arrow bytes the worker already produces for
over-budget results (`noetl_tools::arrow_codec`), so a result transits
worker → object store → plug-in without ever re-serializing. The
worker host (`noetl-worker` `plugin` module) implements this as
`WasmPluginHost::invoke_bytes`; a round-trip test pushes a real Arrow IPC
buffer through and asserts it returns byte-identical.

For plug-ins that talk **across the network** (cell-to-cell, region-to-
region — see the
[Event WAL + Derivable Storage](./event_wal_and_derivable_storage.md)
topology model) rather than in-process, the equivalent is **Arrow
Flight**: stream RecordBatch chunks into the plug-in endpoint instead of
the shared-memory hand-off.

### Distribution

Compiled modules live in the **catalog** (the managed, replaceable plug-in
library) keyed by `(path, version, digest)`. They can also be distributed
as **OCI artifacts** and executed container-native via a `runwasi`-style
shim — a sub-megabyte module with sub-millisecond start, versus tens of
megabytes and a full OS boot for a Linux container.

## The packaging shape (revised v2)

There's **no new compiled binary** for publisher / projector /
system_pool.  The shape collapses:

```
repos/server (Rust crate, single binary)
└── src/main.rs              HTTP server (catalog, /api/execute, /api/events, SSE)

repos/worker (Rust crate, single binary — UNCHANGED)
└── src/main.rs              Generic NATS pull worker.  Already exists.
                             Serves user pools AND the system worker pool —
                             the difference is configuration, not code.
```

Helm deploys the **same `noetl/worker` image three times** with
different env:

| Deployment | Image | NATS_CONSUMER | NATS_FILTER_SUBJECT | Replicas |
|---|---|---|---|---|
| `noetl-server` | `ghcr.io/noetl/server` | (HTTP, no consumer) | — | 1-3 |
| `noetl-worker` (Python pool) | (today's Python image) | `noetl_worker_pool` | (legacy) | 1-20 (KEDA) |
| `noetl-worker-rust` (user pool) | `ghcr.io/noetl/worker` | `noetl_worker_pool_shared` | `noetl.commands.shared.>` | 1-20 (KEDA) |
| `noetl-worker-system-pool` | `ghcr.io/noetl/worker` | `noetl_worker_pool_system` | `noetl.commands.system.>` | 1-5 (KEDA, smaller cap) |

The Python `noetl-outbox-publisher` Deployment and the
`noetl-projector` StatefulSet **retire** once the equivalent
system playbooks (`system/outbox_publisher`, `system/projector`)
are registered in the catalog and the system worker pool is
running.

WASM compilation happens **server-side at catalog register
time** (or first execute) — the system worker pool's wasmtime
host loads the compiled module per claim and discards on
completion.  No additional Rust binary needed for the host —
it lives inside the existing `noetl/worker` binary as a tool
kind / dispatcher mode that activates when the playbook is
flagged for WASM execution.

## Catalog model

System playbooks live under `system/<name>` paths.  Two options
for the catalog `kind`:

### Option 1 — `WasmPlaybook` as a first-class catalog kind

Pros: simple model; explicit; user can register hand-written WASM
if needed.

Cons: exposes WASM as a user-facing surface; loses "all playbooks
are YAML" property.

### Option 2 — YAML stays the source; WASM is an internal
compilation target

Pros: more elegant; playbook authors keep writing YAML; the
platform handles WASM compilation as an internal optimisation;
unified surface.

Cons: requires building the YAML-to-WASM compiler.

**Recommendation:** start with Option 1 for the initial implementation
(faster to ship, validates the runtime + capability + reload
pipeline).  Migrate to Option 2 once the compiler is built.

## WASM dispatch convention

The runtime built for Option 1 is shipped and validated end to end (the
plug-in module registry, the wasmtime host + capability ring, the HTTP
`PluginSource`, the reference plug-in, and the dispatcher's
load → run → collect → flush loop — noetl/ai-meta#105 Rounds 1-5).  What
remains to make it *live* is the **dispatch convention**: how a playbook
declares WASM execution, and how the command routes to the host instead
of the tool registry.

### How a playbook opts in (author-facing)

A catalog playbook — in the Option-1 phase, typically a `system/`
playbook — opts into compiled execution with an `executor` block:

```yaml
executor:
  runtime: wasm                 # vs the default interpreted runtime
  plugin:
    path: system/materialiser   # catalog path of the compiled module
    version: 3                  # catalog version
    # digest is NOT authored — the registry is the digest authority
  capabilities:                 # the granted ring (a subset of the host's)
    - object_put
    - result_put
    - event_publish
```

- The author never writes a digest.  The plug-in module registry
  (`noetl.plugin_module`, served by `GET /api/internal/plugins/{path}`)
  is the digest authority; the worker pins the digest it fetched into its
  cache key.
- `capabilities` narrows the host's full ring per plug-in
  (defense-in-depth): a plug-in is granted only the host functions it
  declares.  Omitting the list grants nothing (deny-by-default, matching
  `NullCapabilities`).

### Wire shape and routing

- The orchestrator / system-pool runner, dispatching a step flagged
  `runtime: wasm`, emits a command with **`tool_kind: "wasm"`** and an
  `input` carrying the step's payload plus the plug-in reference
  (`{path, version}`) and the granted capability list.  `tool_kind` is the
  worker's dispatch discriminator, so routing needs no new command field —
  the author-facing `executor.runtime: wasm` lowers to a `tool_kind:
  "wasm"` command.
- The worker dispatch, on `tool_kind == "wasm"`, resolves the digest from
  the registry, builds the `PluginKey{path, version, digest}`, and calls
  `WasmDispatcher::run_and_apply(key, input, client, execution_id, step)`
  — load (catalog fetch + hot-reload on a version bump) → invoke over the
  data-plane ABI → collect `CapIntent`s → flush to the control plane.  The
  capability ring is scoped to the declared `capabilities`.
- **Input** to the plug-in is the command's payload bytes (for the
  materialiser, a batch of events / the trigger payload); its **output**
  plus the flushed intents are the step result.

### Error surfacing (resolves Open question 2)

A WASM module panic is a `wasmtime::Trap`, which the host already turns
into a `PluginError::Invoke` rather than crashing the worker.  The
dispatcher surfaces it as a contained `call.error` structured event for
that step — the system-pool worker keeps running and the failure is
visible in the event log, exactly like a tool error.

### The one open design choice

`tool_kind: "wasm"` (a tool kind) vs an `executor` field on the command
envelope.  **Recommendation: `tool_kind: "wasm"`** — it reuses the
existing dispatch discriminator with zero new command/envelope fields,
and the author-facing surface stays the richer `executor` block that
lowers to it.  The alternative (a first-class `command.executor` field)
is cleaner conceptually but ripples through the command schema across
server + worker + the executor crate for no near-term benefit.

## Open questions

1. **What is the minimum compiled core?** The current cut is
   "publisher + projector + HTTP routing + execution-id resolve
   + scrub".  Could the HTTP routing itself be plug-in-driven
   (router tree as a system playbook)?  Probably not, but worth
   considering for the ADR finalisation.
2. **How are system-playbook errors surfaced?** A WASM module
   panic should be a contained failure, not a system-pool worker
   crash.  `wasmtime` handles this via `Trap`; surface as a
   structured event.
3. **Per-tenant override scope.** Should every system playbook
   be tenant-overridable, or only a curated subset (e.g. auth,
   RBAC)?  Trade-off between flexibility and surface area for
   security review.
4. **Versioning.** Catalog versions today are per-playbook.  A
   system playbook's WASM digest is derived from the YAML + the
   compiler version + the host capability set version.  How do
   we handle host capability evolution (adding a new host
   function)?  Probably via a host-version field on the WASM
   module's import list.
5. **Audit trail for system actions.** Every system playbook
   execution emits events (same as user playbooks).  Are they in
   the same `noetl.event` table or a separate `noetl.system_event`
   table with stricter ACL?

## Related

- [Ephemeral Blueprints and the Compute-Data Boundary](./ephemeral_blueprints.md)
  — the design principle this extends.
- [Appendix H — Rust migration path](./noetl_global_hybrid_cloud_grid_distributed_architecture_blueprint.md#h-rust-migration-path-and-unified-executor-roadmap)
  — the worker-side Rust migration.
- [Agent Orchestration](./agent_orchestration.md) — how agents
  fit alongside the system pool concept.
- [Playbook-as-MCP-Server](./playbook_as_mcp_server.md) — same
  spirit (playbooks expose surfaces), different layer.
- [noetl-server runtime shape page](https://github.com/noetl/server/wiki/runtime-shape)
  — implementation-level wiki page for the compiled core / plug-in
  split.
- [noetl-ops system pool deploy page](https://github.com/noetl/ops/wiki/system-worker-pool)
  — Helm + manifest patterns for the system pool.
