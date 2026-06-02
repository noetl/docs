---
id: system_pool_and_wasm_plugins
title: System Worker Pool and WASM Plug-in Surface
sidebar_label: System Pool & WASM Plug-ins
sidebar_position: 8
---

# System Worker Pool and WASM Plug-in Surface

**Status:** Design proposal (ADR) — tracked under
[noetl/ai-meta#45][issue-45] (compiled replacement) and
[noetl/ai-meta#46][issue-46] (plug-in surface).  Not yet
implemented.  This page captures the design space so the next
agent picking up the work has the trade-offs already mapped.

For the higher-level shape this design extends, see
[Ephemeral Blueprints and the Compute-Data Boundary](./ephemeral_blueprints.md).

[issue-45]: https://github.com/noetl/ai-meta/issues/45
[issue-46]: https://github.com/noetl/ai-meta/issues/46

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

## The split — compiled core vs. plug-in ring

Not everything belongs as a playbook.  The shape that emerged
from the design discussion:

### Compiled core (stays in Rust)

The hot loops where playbook-dispatch overhead would cost real
throughput:

- **Outbox publisher** — `LISTEN/NOTIFY` on Postgres outbox table,
  publish to `NOETL_EVENTS` NATS stream.  ~200 lines of tight loop,
  no per-row extensibility needed.
- **Projector** — NATS subscribe, batch-INSERT into `noetl.event`
  table.  Thousands of events/sec at peak; WASM's 2-5× overhead
  and cross-boundary memory copies are real cost here.
- **HTTP route table + scrub** — `/api/catalog/*`, `/api/execute`,
  `/api/events`, SSE.  The router itself stays compiled; the
  customisable bits (auth check, RBAC) move to the plug-in ring.
- **Execution-id resolution + dispatch fan-out** — the
  inner loop of `_handle_event_inner`.

### Plug-in ring (system playbooks, dispatched on `worker-system-pool`)

The cold loops where pluggability and per-tenant override matter
more than per-call latency:

- **Auth** (`system/auth`) — session validation, token lookup,
  IdP integration.  Tenants can override with `acme/system/auth`
  for SAML, custom MFA, etc.
- **RBAC** (`system/rbac`) — per-action authorisation.  Customisable
  per tenant.
- **Scheduled cleanup** (`system/scheduled_cleanup`) — TTL
  enforcement, stale-row reaping.  Low frequency (cron-like),
  benefits from the catalog versioning + replay semantics.
- **Credential rotation** (`system/credential_rotate`) — refresh
  long-lived tokens before expiry.
- **Custom dispatcher rules** — tenant-supplied logic for routing
  decisions, e.g. "route all `mcp` calls for tenant X to pool Y".

The compiled core is **small and stable**; the plug-in ring is
where extension happens.  Matches the "kernel + modules" pattern
— boring, well-understood, debuggable.

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

## The packaging shape

```
repos/server (Rust crate)
├── src/bin/server.rs       --mode=server     (HTTP routes)
├── src/bin/publisher.rs    --mode=publisher  (LISTEN/NOTIFY → NATS)
├── src/bin/projector.rs    --mode=projector  (NATS → DB)
├── src/bin/system_pool.rs  --mode=system     (wasmtime host)
├── src/lib.rs              shared: envelope, db pool, nats client, scrub, metrics
└── src/wasm/
    ├── host.rs             wasmtime Linker + capability surface
    ├── cache.rs            (path, version, digest) -> compiled Module
    └── caller.rs           dispatch system playbook -> WASM execution
```

One image (`ghcr.io/noetl/server:<v>`).  Multiple deployments
in Helm, each with different `args:`:

| Deployment | args | Replicas |
|---|---|---|
| `noetl-server` | `--mode=server` | 1-3 (HTTP) |
| `noetl-outbox-publisher` | `--mode=publisher` | 1 |
| `noetl-projector` | `--mode=projector` | N (sharded) |
| `noetl-worker-system-pool` | `--mode=system` | 1-3 (KEDA on `noetl_worker_pool_system` lag) |

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
