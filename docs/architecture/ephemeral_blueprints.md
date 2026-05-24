---
id: ephemeral_blueprints
title: Ephemeral Blueprints and the Compute-Data Boundary
sidebar_label: Ephemeral Blueprints
sidebar_position: 1
---

# Ephemeral Blueprints and the Compute-Data Boundary

The foundational principle that the rest of the NoETL architecture
derives from. New features, deployment changes, integrations, and
operational reviews should be measured against this page first.

For the runtime contract that implements it, see
[NoETL Distributed Runtime + Event-Sourced Shared Memory Spec](../features/noetl_distributed_runtime_spec.md).
For higher-level platform views, see
[NoETL Catalog-Driven MCP Architecture](./mcp_catalog_architecture.md),
[Agent Orchestration](./agent_orchestration.md), and
[Playbook-as-MCP-Server](./playbook_as_mcp_server.md).

## One-paragraph statement

NoETL runs work as a distributed runtime where **playbooks are
ephemeral blueprints** that describe control flow and policy,
**workers execute atomic compute blocks**, **the gateway is a
gatekeeper** for auth and routing, and **all state lives in a
shared cache with an event log as the source of truth**. Data
is touched only inside playbook steps. Long-lived processes are
not required; callbacks and hooks let workers resume the latest
state of an `execution_id` block-by-block without keeping
anything waiting in memory.

## Roles and boundaries

### Gateway

- **Owns:** session authentication, authorization, SSE / callback
  delivery to clients, subscription routing, request-id correlation.
- **Does not own:** data reads, data writes, business logic,
  caching of domain state. The gateway never touches a database
  on behalf of a client. It validates the request, hands off to a
  playbook execution, and forwards events back.
- **Implication:** a feature that requires the gateway to read or
  mutate domain data is the wrong shape. The feature belongs in a
  playbook that the gateway invokes.

### Worker

- **Owns:** execution of atomic compute blocks (one step at a
  time per claim). Tool dispatch (`python`, `postgres`, `nats`,
  `agent`, etc.). Event emission for every block boundary.
- **Does not own:** orchestration, persistent agent state,
  process-resident MCP server lifetimes. Workers are pool-scaled
  and stateless.
- **Implication:** workers can be added, removed, or restarted
  freely. Work in flight survives because state lives in the
  shared cache + event log, not inside the worker process.

### Playbook

- **Owns:** control-flow logic, data-access policy, retry rules,
  failure handling, what tool runs in what order with what
  inputs. A playbook is an ephemeral blueprint: it describes how
  computation should proceed for a given request, then gets
  invoked.
- **Does not own:** durable process state. A playbook
  *invocation* (an `execution_id`) has state — but the state
  lives in the cache and event log, not in any specific process.
- **Implication:** the playbook is the place to express
  "rules and policies that govern any data touch." If a
  client needs to read or write something, the path is always
  client → gateway → playbook → tool → data.

### Shared cache (state vehicle)

- **Owns:** the input and output of atomic compute blocks
  while a playbook is in flight. Arrow IPC for fast tabular
  payloads; small immutable payload refs for structured data;
  block-scoped keys derived from `execution_id` + step.
- **Does not own:** the system of record. The cache is
  rebuildable from the event log at any point.
- **Implication:** any worker on any pod that claims the next
  block reads its inputs from the cache and writes outputs to
  the cache. No worker needs to know which other worker ran the
  previous block.

### Event log (system of record)

- **Owns:** the append-only, immutable record of everything
  that happened. Replay against the event log reproduces state
  for any `execution_id` at any past time.
- **Does not own:** transient cache state, in-process buffers,
  or worker memory.
- **Implication:** every block transition emits one or more
  events. Auditability, replay, and recovery all derive from
  this.

## Data access policy

**Any data touch is performed by a playbook step under that
playbook's declared rules.** Clients never reach a database
directly. The gateway never reaches a database to satisfy a
client request.

- **Writes:** every write goes through a tool inside a playbook
  step (`postgres`, `nats`, an MCP `tool: agent` for systems
  like Firestore). The playbook's policy block governs auth,
  retry, idempotency, and error handling for that write.
- **Reads:** the same path. Even read-only views compose by
  invoking a playbook that returns the projection. For
  push-style live updates, the gateway opens a subscription
  on the client's behalf, attaches the listener server-side
  with the right scope, and forwards events over SSE — the
  client never holds a database credential.
- **Credentials:** database and third-party credentials live
  in NoETL's keychain, accessible only from inside playbook
  execution. They never reach a browser bundle.

The rationale is not just security. Concentrating data-touch
policy inside playbooks keeps audit, replay, retry, and
schema-evolution rules in one place. Two different clients
calling the same playbook get the same rules — there's no
out-of-band path that bypasses them.

## Atomic compute blocks

A playbook decomposes work into discrete steps. Each step
becomes a **block** the worker pool claims, executes, and
acknowledges.

A block is:

1. **Claimed** by a worker from the NATS command stream.
2. **Hydrated** from the shared cache (inputs).
3. **Executed** by a tool (sub-second to seconds for trivial
   blocks; longer for blocks that wait on external systems).
4. **Persisted** by writing the output to the shared cache.
5. **Recorded** by emitting events to the event log
   (`step.exit`, `command.completed`, `call.done`).
6. **Released** by acknowledging the NATS message, freeing the
   slot.

The block boundary is the unit of recovery. If a worker dies
mid-step, the same command is redelivered (the consumer's
`ack_wait` governs the redelivery window) and another worker
claims it. The event log distinguishes "started but not
completed" from "completed" without ambiguity because the
worker emits explicit boundary events.

Arrow IPC and shared-memory carriers handle the payload moves
that would otherwise dominate end-to-end latency. The point is
that the **block contract** is the same whether the payload
lives in-memory, on local NVMe, in distributed K/V, or in a
columnar projection.

## Why ephemeral wins (cost and performance)

The shape avoids the failure modes of long-lived per-tenant
agent infrastructure:

- **No persistent AI-agent processes.** An LLM call is a tool
  invocation inside a step. The step completes and releases
  its worker slot. There's no "agent process" to keep warm,
  monitor, autoscale, or pay for between requests.
- **No persistent MCP server instances.** An MCP server is a
  playbook in the catalog. When a step needs it, the runtime
  dispatches the playbook (nested or in-process). When the
  step finishes, nothing stays resident.
- **Worker pools scale on actual block backlog, not on
  "expected concurrent agents."** KEDA reads NATS JetStream
  consumer lag and scales the pool against real demand.
  Scale-to-zero is a configuration choice, not a code change.
- **Each integration is a playbook, not a deployment.**
  Adding a new MCP server or third-party adapter does not
  require a new pod, sidecar, or service. The catalog gains a
  row; the runtime instantiates it on demand.

The trade-off is per-block overhead from the event-sourced
choreography: a step that does a single trivial action still
spends time on NATS roundtrips, ack coordination, and event
writes. That overhead is paid in exchange for the properties
above and is the right place to optimize at the platform level
(batched event writes, inline trivial children, lower
prefetch latency) rather than by retaining processes.

## Callbacks and hooks as a power feature

Long-running operations do not need to keep a worker process
waiting. The pattern:

1. The playbook step that initiates an external operation
   captures an `execution_id` and a callback subject /
   webhook URL.
2. The step returns; the worker slot frees.
3. When the external system finishes, it sends a callback
   carrying the `execution_id` (and any business identifiers).
4. The callback handler (the gateway, or a callback playbook)
   applies the payload to the **latest state of the
   `execution_id` instance** and emits the resume event.
5. The next block claims off NATS and continues atomic
   execution from the recorded state.

The implication: a playbook can integrate an LLM streaming
response, a slow third-party order placement, or a
multi-second Firestore index update without holding a worker
for the duration of the wait. Time in the external system is
free; only the moments when blocks actually run consume the
pool.

This is what makes agentic AI work cost-effective on NoETL.
An "AI agent" in this model is a directed sequence of blocks
that may include LLM tool calls, MCP dispatches, and waits on
external events. Each piece is a block. The pool processes
blocks. Nothing is persistent except the blueprint and the
event log.

## How to decide where a feature lands

A short decision tree for engineers and AI agents adding
work to NoETL:

1. **Does the feature initiate work, gate access, or route
   responses?** It belongs in the gateway (Rust). Keep it
   stateless beyond session and subscription bookkeeping.
2. **Does the feature touch data, call an external API, or
   compose multiple operations under business rules?** It
   belongs in a playbook (YAML in the catalog). The playbook
   declares its policy block; tools execute the steps.
3. **Does the feature execute a unit of computation
   (transform a payload, run a query, invoke an LLM)?** It
   belongs in a worker tool (`tool: kind: …`). Add a new tool
   kind only if no existing one fits.
4. **Does the feature need shared state between blocks?** It
   belongs in the shared cache (Arrow IPC payloads + scoped
   keys). The event log records what happened; the cache
   carries what the next block reads.
5. **Does the feature wait on something external?** Use a
   callback / hook pattern. Do not hold a worker slot for
   the wait.

If a proposal places data-touch logic in the gateway, holds
process state in a worker for the duration of an external
wait, or stands up a persistent per-tenant agent service,
that proposal is in the wrong shape under this model. The
shape under this model is gateway → playbook → tool → block
→ cache → event log → (callback resumes) → next block.

## What this means for clients

A client (SPA, mobile app, CLI, MCP consumer, partner
integration) holds only:

- A session token issued by the gateway.
- An SSE / subscription connection to receive push updates.
- The ability to invoke playbooks by path with a workload.

A client does not hold:

- Direct database connections or credentials.
- Long-lived state about in-flight work (the gateway's
  subscription stream is authoritative).
- Knowledge of which worker pod ran which step.

When a client needs live data, it asks the gateway to open a
subscription. When a client needs to act, it invokes a
playbook. The shape is uniform across surfaces.

## Related

- [NoETL Distributed Runtime + Event-Sourced Shared Memory Spec](../features/noetl_distributed_runtime_spec.md)
  — the runtime contract that implements this principle.
- [NoETL Catalog-Driven MCP Architecture](./mcp_catalog_architecture.md)
  — the catalog that makes playbooks discoverable as MCP
  servers.
- [Agent Orchestration](./agent_orchestration.md) — how
  `tool: kind: agent` dispatches sub-playbooks, including
  the noetl framework that lets a playbook be the agent.
- [Playbook-as-MCP-Server](./playbook_as_mcp_server.md) —
  why playbooks themselves are the unit of MCP composition.
- [Sink-Driven Storage](./sink_driven_storage.md) — how the
  cache and storage tiers fit the block model.
