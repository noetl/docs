---
sidebar_position: 3
title: Architecture
description: NoETL system architecture and components
---

# Architecture

NoETL uses a server-worker architecture for distributed workflow execution.
This page describes the **distributed** mode: the clustered control loop of
gateway, server, worker pools and EHDB. The same playbooks also run without a
cluster, in-process through the CLI or as a resident `noetl subscribe` daemon.
See [Deployment Modes](/docs/architecture/deployment_modes).

## Component Overview

![NoETL Components](/img/noetl-components.png)

## Components

### Gateway

Rust-based API gateway for external clients:
- Exposes GraphQL API for playbook execution
- Provides REST API for Auth0 authentication (`/api/auth/*`)
- Session validation middleware with EHDB K/V caching
- Pure gateway design - no direct database connections
- All data access through Control Plane API
- EHDB K/V for fast session lookups, served by the writer's KV face
- Live updates stream from the EHDB event feed

**Session Caching:** Gateway checks EHDB K/V for cached sessions before calling auth playbooks. On cache miss, playbooks validate from PostgreSQL and refresh the cache. Both gateway buckets — `sessions` and `requests` (the latter backing every SSE route) — moved from NATS K/V onto the EHDB KV face with the NATS removal.

### NoETL Control Plane

Central coordination service:
- Exposes REST APIs for catalog, credentials, executions, and events
- Schedules and supervises workflow executions
- Publishes task notifications to the EHDB feed (L1 command bus)
- Receives execution events from workers
- Manages retries and backoff policies
- Reconstructs workflow state from the projected execution read-model, folded
  from EHDB's authoritative event log
- Used by CLIs, UIs, and integrations

### Event Store and Projections

NoETL's authoritative event log is
[EHDB](https://github.com/noetl/ehdb) (the Event Horizon Database), an
Arrow-native storage substrate purpose-built for the NoETL platform. EHDB's
event-log engine has been `primary` — serving production writes and reads —
since 2026-08-13, replacing PostgreSQL as the append-only source of truth for
execution history:

- The **event log** is EHDB's source-of-truth engine: append-only,
  single-writer-per-shard, with a total `global_sequence` order. This is the
  engine every projection folds from.
- The **projection** engine folds the event log into read models — executions,
  event read-models, and analytical/vectorized retrieval views. Projection is
  currently still served from PostgreSQL (`noetl.event` and its derived
  tables) while the equivalent EHDB projection engine runs in shadow mode
  alongside it, ahead of its own cutover.
- Replay validation reads the event log and checks projected runtime state
  without depending on worker memory — the same replay guarantee as before,
  now backed by EHDB rather than PostgreSQL for the raw log.
- This is exposed read-only through the **noetl server API**, under
  `/api/ehdb/*`, and through the `noetl ehdb query` CLI — a secret-free,
  bounded, platform-only query surface. The server stays control-plane-only
  (it never opens EHDB's data-plane storage itself); raw per-tier reads are
  relayed to the worker's data-plane query port.

EHDB is designed to progressively absorb the platform roles currently split
across PostgreSQL, NATS JetStream, and external object stores. It owns **four
engines**: **event log**, **projection**, **KV** and **object**. Vectorized
retrieval and analytical views are projections, not separate engines. The
standalone OLAP and ANN/vector engines were *removed* from scope, and nothing
external replaces them. The catalog is a projection too.

The event log and the L1 feed (the command bus, below) are cut over in
production today. The projection, KV and object engines are mid-migration:
shadow-mirrored, and not yet authoritative.

**Single writer.** The event log's total order assumes at most one appender
per shard. Today that is enforced by `replicas: 1` on the EHDB writer
StatefulSet (`noetl-cmdbus-writer`). A Kubernetes-Lease election, with the
Lease's `leaseTransitions` as the fencing epoch, and a write fence are built,
but both are off by default and not yet authoritative. See
[Deployment Modes](/docs/architecture/deployment_modes#distributed-the-clustered-control-loop).

**On-disk compatibility.** EHDB's manifest (its catalog of immutable parts)
changes by **expand first**:

1. Release A teaches readers the new shape while writers keep the old bytes.
2. Release B switches writers per store, behind an environment variable, only
   after every reader runs A.

Since v0.15.1, a reader that meets a well-formed manifest it can't decode
**refuses to open the store** rather than falling back silently. The first
change made under this rule is **bloom scheme 2** (`EHDB_BLOOM_SCHEME=2`):

- Each bloom probe is an independent SplitMix64 mix, in place of the legacy
  double-hashing scheme, which could degenerate until every probe hit one bit.
- Filters are sized by the number of distinct keys.
- It is serialized as `"scheme":2` in the manifest.

Readers shipped in v0.15.0. Writers were armed on NoETL production on
2026-11-07, first for the server's embedded stores and then for the
command-bus writer. The code default is still the legacy scheme. See the
[manifest-format compatibility spec](https://github.com/noetl/ehdb/blob/main/docs/spec/manifest-format-compat.md).

See
[noetl/ehdb](https://github.com/noetl/ehdb) and its
[wiki](https://github.com/noetl/ehdb/wiki) for the live, continuously-updated
cutover status per engine — this page describes the architectural shape, not
a point-in-time rollout snapshot.

The DSL and playbooks stay backend-neutral throughout this migration;
infrastructure configuration selects the adapters, not the workflow
definition.

### ehgraph (Topology Graph)

[ehgraph](https://github.com/noetl/ehgraph) is NoETL's topology database: one
instance per *domain*, holding nodes, edges and their relationships, and
exposed as tools over MCP and HTTP. One engine runs in two modes, with the same
log format, tools, grants, sessions and budgets in both:

- **Embedded.** A host process opens it in-process and mounts its router. The
  `noetl-cluster` domain is embedded in `noetl-server` at
  `/ehgraph/noetl-cluster`. It is **off unless `NOETL_EHGRAPH_EMBEDDED=true`**,
  and refuses to open unless the host declares itself the single writer
  (`host_replicas = 1`). An embedded domain has no StatefulSet of its own:
  rolling the graph is rolling the server.
- **Standalone.** `ehgraph serve`, deployed as a `replicas: 1` StatefulSet.
  The `network` domain (qnetmon) runs this way.

ehgraph keeps its own append-only log and snapshots in its data directory. It
does **not** store on EHDB; it only reuses EHDB's frame shape. Today each
domain has one primary with a single writer. Read replicas and warm standby
need a Lease election and are on the roadmap, not built. See
[Embedding](https://github.com/noetl/ehgraph/blob/main/docs/wiki/Embedding.md)
and [Roadmap](https://github.com/noetl/ehgraph/blob/main/docs/wiki/Roadmap.md).

**Query interface.** Alongside its fixed tools (`graph.upsert`,
`graph.deactivate`, `graph.query`, `graph.neighbors`, `graph.path`, and so on),
which stay the stable contract for writers, ehgraph accepts a subset of
**openCypher** (aligned with GQL) for reads and writes:

| Interface | Route | Notes |
|---|---|---|
| MCP tool `graph.cypher` | `POST /mcp`, `tools/call` | Same envelope as the other tools |
| HTTP | `POST /v1/cypher` | Same body as the MCP tool |
| Neo4j Query API v2 | `POST /db/{namespace}/query/v2`, explicit transactions under `.../query/v2/tx` | Works with Query API clients |
| Bolt 5.0 / 4.4 | `[bolt] listen = "..."` in the standalone server's config | Off unless configured. Official Neo4j drivers over `bolt://` (no TLS or `neo4j://` routing yet) |

How these reach the graph depends on the mode:
- **Embedded.** noetl-server mounts the HTTP routes under
  `/ehgraph/noetl-cluster`, so the Query API is at
  `/ehgraph/noetl-cluster/db/{namespace}/query/v2`. The server does **not**
  open a Bolt listener.
- **Standalone.** A standalone `ehgraph-server` opens Bolt only when its
  config has a `[bolt]` section.

**Transactions.** Writes are atomic and serializable.
- **Multi-statement transactions** are available as `graph.tx.begin`, `run`,
  `commit` and `rollback`, through the Query API's `/tx` routes, and through
  Bolt `BEGIN`/`COMMIT`. They give snapshot reads plus read-your-writes, and
  commit as one graph version or not at all.
- **Concurrency is optimistic.** The first committer wins, and a conflicting
  commit fails with `VERSION_CONFLICT` (409).
- **Conditional commits.** A write can pass `expect` (element or graph
  versions it requires) and is applied only if they still hold.

The subgraph fix in the same release makes `graph.subgraph` keep a seed's
depth when another seed also reaches it.

noetl-server 3.156.2 embeds ehgraph `f200516`, which includes all of this.
The on-disk store format is unchanged, so a server rollback still opens the
graph.

**Supported subset.** The supported Cypher subset, the gap table and the
openCypher TCK results are in the ehgraph
[Cypher](https://github.com/noetl/ehgraph/blob/main/docs/wiki/Cypher.md)
page. On TCK 2024.3, ehgraph passes 58.8% of all scenarios and 84.1% of
in-model scenarios; most remaining failures create unlabeled nodes.
Transaction semantics are in
[Transactions](https://github.com/noetl/ehgraph/blob/main/docs/wiki/Transactions.md).
For the instance graph that noetl-server writes, see
[Interop](/docs/architecture/interop#instance-registration-and-discovery).

### Worker Pools

Stateless background executors:
- Subscribe to the EHDB feed (L1 command bus) for task notifications. A
  worker's pool comes from its feed filter subject
  (`NOETL_FEED_FILTER_SUBJECT`), and it refuses to start without one.
- Retrieve task details via Control Plane API
- Run workflow steps and tools (HTTP, SQL, Python, etc.)
- Report events back via Control Plane API
- Scale horizontally with KEDA on EHDB feed lag (`ehdb_feed_subject_lag`)
- Isolated execution environments

Two pools run in production. The **`shared`** pool runs user playbooks. The
**`system`** pool runs system playbooks and the orchestration drive, and is the
only pool sharded by subject. Playbooks under `subscription/` route to a
`subscription` pool, and registered subscriptions run on the
`noetl-subscription-runtime` Deployment.

### EHDB Feed (L1 Command Bus)

[EHDB](https://github.com/noetl/ehdb)'s feed engine is the production
command bus for task distribution, replacing NATS JetStream in this role
since 2026-07-27:
- Control Plane publishes task notifications to the EHDB feed
- Workers claim and acknowledge messages through durable, per-shard delivery
- Messages contain pointers to Control Plane API for task details, not the
  full payload
- Durable subscriptions and exactly-once claim semantics ensure no task loss
- Supports multiple worker pools and load balancing, and has measured
  materially faster dispatch latency than the NATS baseline it replaced

NATS JetStream has since been removed as an internal transport
(noetl/ai-meta#212); there is no NATS rollback path and no NATS deployment in
production. The EHDB feed is the task-distribution system of record.

NATS survives in NoETL only as something playbooks talk *to*: the `nats` tool
kind and the `subscription` tool's NATS source. The local kind bootstrap still
deploys a NATS JetStream instance for those.

### Result References and Shared Cache

Workers do not push large payloads through the event stream. Task outcomes use a
reference-first model:

- Small values may be inline.
- Larger results are stored behind a `ResultRef` / `TempRef` with a logical
  `noetl://...` URI.
- The durable reference remains the source of truth and can resolve from KV,
  disk, S3-compatible storage, GCS, or PostgreSQL depending on tier and runtime
  configuration.
- Tabular cursor-frame payloads can be serialized as Apache Arrow IPC
  (`application/vnd.apache.arrow.stream`).
- Co-located producer/consumer workers can attach to an optional same-node
  shared-memory `ipc` hint on the reference. This is Tier 1.5: a best-effort
  acceleration path, not authoritative state.
- If the IPC hint is missing, expired, evicted, or belongs to a different node,
  resolution falls back to the durable `ResultRef`.

The live Phase 3 IPC proof validated this path end to end: a cursor frame wrote
Arrow IPC bytes, emitted an IPC hint, read via shared memory, evicted the hint,
then successfully read the same rows through durable fallback.

### Catalog & Credentials

Storage for workflow definitions:
- **Catalog**: versioned resources registered through `/api/catalog/register`.
  There are six kinds, constrained by the `noetl.resource` table:
  `playbook`, `credential`, `mcp`, `agent`, `memory` and `subscription`.
  `subscription` is the only kind with its own validation; its sources are
  `pubsub`, `nats`, `kafka` and `webhook`. PostgreSQL (`noetl.catalog`) is
  still the read authority. The EHDB catalog log is written alongside it in
  shadow.
- **Credentials**: Connection configs and tokens with scoped access

### Event Bus and Telemetry

Observability infrastructure:
- Every step emits structured events (start/finish/errors, durations). They
  land on EHDB's event log, which is NoETL's own operational record.
- Metrics go to VictoriaMetrics.
- ClickHouse is a **business-data** store that NoETL provisions and feeds, for
  example network logs. NoETL's core events and state never depend on it.
- Vector stores (Qdrant) for AI-assisted optimization and semantic search

### Storage/Compute Integrations

Connectors for external systems:
- Warehouses: DuckDB, PostgreSQL, ClickHouse, Snowflake
- Files/Lakes: GCS, S3, local filesystem
- Vector DBs: Qdrant
- External services: HTTP APIs

### Language Model Strategy: Open-Source SLMs with Hybrid LLM Escalation

NoETL treats model selection the same way it treats storage or compute
backends: as an explicit, swappable workload configuration, not a hardcoded
dependency.

- **Domain-specific small language models (SLMs) run first.** Workloads
  default to a local, open-source SLM served via Ollama (`gemma3:4b` today)
  tuned for a specific domain task. The pattern is proven for
  self-troubleshoot diagnosis and extends the same way to other
  domain-centric playbooks (risk scoring, healthcare cohort summarization,
  observability triage, and similar). Small models keep inference local,
  fast, and low-cost, and they run on commodity hardware — a laptop, a small
  kind cluster, or a memory-constrained worker node.
- **Escalation is explicit and hybrid, never silent.** When a local SLM's
  confidence falls below a workload-defined threshold, NoETL escalates
  through the same MCP contract to either a larger local open-source model
  (`qwen3:32b`) or a managed cloud LLM backend (Vertex AI/Gemini, OpenAI,
  Claude). Backend selection is always explicit per deployment or per
  workload — NoETL does not auto-detect an environment and silently switch
  tiers.
- **The backend is a pluggable MCP contract, not a code branch.** Every
  compatible tier speaks the same JSON-RPC MCP `chat_completion` interface:
  `diagnose_execution -> tool.kind=mcp -> mcp/<backend> -> chat_completion`.
  The same playbook runs unmodified against a laptop's local Ollama pod or a
  production Vertex AI backend by changing `triage_mcp_server` /
  `triage_model`, not the workflow definition.

See [Triage Model Selection](/docs/architecture/triage_model_selection) and
[Vertex AI Triage Backend](/docs/architecture/vertex_ai_triage_backend) for
the concrete open-source-SLM-first, hybrid-escalation pattern running in
production today, including the local-tier-to-cloud-tier mapping
(`gemma3:4b` → `gemini-2.5-flash`, `qwen3:32b` → `gemini-2.5-pro`).

## Quantum Computation Workloads

NoETL's Petri-net-inspired token model (see
[Design Philosophy — Petri Net-Inspired State & Parallelism](/docs/getting-started/design-philosophy#petri-net-inspired-state--parallelism))
extends to quantum computation without a special case: a quantum job's
output — measurement bitstrings, shot counts, correlation estimates, or
derived embeddings — is a step result like any other, so it flows through
the same replayable, event-sourced execution graph as classical steps.

A typical pattern:

1. A step submits a quantum circuit through a provider tool — the IBM
   Quantum Runtime API, or an NVIDIA cuQuantum/Qiskit Aer simulator — as
   shown in the
   [Quantum Networking Runner](/docs/examples/integrations/quantum_networking_runner)
   example.
2. The provider's raw output becomes that step's result token, subject to
   the same [Result References and Shared Cache](#result-references-and-shared-cache)
   model as any large payload.
3. Downstream steps route that token to GPU or CPU worker pools (see
   [Resource Pools](#resource-pools)) for classical post-processing: error
   mitigation, feature extraction, or training and inference against a
   domain-specific model.
4. Because the token is durable and replayable, customers can compose
   playbooks that train their own models on accumulated quantum-workload
   output — the same compositional pattern used for any other domain data
   product in NoETL.

For the dedicated quantum-orchestration layer — circuit design, provider
routing, and quantum-specific scheduling beyond what a NoETL playbook step
covers directly — see [saqbit — quantum orchestration](https://saqbit.com/#docs).
NoETL's role is to make quantum job output a first-class, replayable token in
the same execution graph as every other domain workload; saqbit is the
dedicated quantum-orchestration layer NoETL integrates with for the
quantum-specific parts of that pipeline.

## Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌───────────────┐     ┌─────────────┐
│   Web UI    │────▶│   Gateway   │────▶│ Control Plane │────▶│  EHDB Feed  │
│  (GraphQL)  │     │   (Rust)    │     │    (Rust)     │     │(L1 cmd bus) │
└─────────────┘     └─────────────┘     └───────┬───────┘     └──────┬──────┘
                                                │                    │
┌─────────────┐                                 │              ┌─────▼─────┐
│   CLI/API   │─────────────────────────────────┘              │  Workers  │
│  (Direct)   │                                 │◀─────────────│ (Execute) │
└─────────────┘                                 │  (events)    └───────────┘
                                                ▼                    
                                        ┌─────────────┐     
                                        │    EHDB     │     
                                        │ (Event Log) │     
                                        └─────────────┘     
```

1. **Web UI** sends GraphQL requests to Gateway
2. **Gateway** authenticates and forwards to Control Plane API
3. **CLI/API** can also call Control Plane directly
4. **Control Plane** validates, creates execution, publishes task to the EHDB
   feed (L1 command bus)
5. **Workers** receive an EHDB feed message with task pointer
6. **Workers** fetch task details from Control Plane API
7. **Workers** execute steps and report events to Control Plane API
8. **Control Plane** appends events to EHDB's authoritative event log (the
   PostgreSQL-backed projection/read-model is folded from this log; see
   [Event Store and Projections](#event-store-and-projections))
9. **Control Plane** monitors events to determine next steps in workflow
10. **Large results** are stored by reference; events carry ResultRef metadata
11. **Cursor frames** may attach an optional Arrow IPC shared-memory hint for
    same-node consumers, while durable storage remains the fallback

## Database Schema

PostgreSQL still holds NoETL's control-plane metadata, and — during the
ongoing EHDB migration — the projection/read-model view over execution
history:

| Table | Purpose |
|-------|---------|
| `catalog` | Playbook definitions (path, version, content) |
| `event` | Execution read-model (status, results, errors), folded from EHDB's authoritative event log |
| `credential` | Encrypted credentials |
| `keychain` | Runtime token cache with TTL |
| `transient` | Execution-scoped variables |
| `runtime` | Worker pool and server registration |
| `schedule` | Cron/interval scheduled playbooks |

The raw, source-of-truth event log itself is EHDB, not this `event` table —
see [Event Store and Projections](#event-store-and-projections). This table
remains the live projection/read-model source while EHDB's own projection
engine runs in shadow mode ahead of its cutover.

**Control loop**: Control Plane analyzes the projected execution state to
reconstruct workflow progress and determine next steps, then publishes tasks
to the EHDB feed.

## Communication Patterns

### Control Plane → EHDB Feed → Worker

Task distribution via EHDB's L1 command bus (see
[EHDB Feed (L1 Command Bus)](#ehdb-feed-l1-command-bus)):
1. Control Plane publishes task notification to the EHDB feed
2. Message contains execution_id and task pointer (not full payload)
3. Worker claims the message, acknowledges after processing
4. Worker calls Control Plane API to get full task context
5. Worker executes and reports events to Control Plane API

NATS JetStream previously served this role and has been removed
(noetl/ai-meta#212).

### Event-Driven State

All execution state is persisted as events in EHDB's authoritative event log:
- Server reconstructs workflow state from the projected execution read-model
  (currently PostgreSQL, folded from the EHDB event log)
- Determines which steps completed, which are pending
- Publishes next tasks to the EHDB feed based on workflow graph
- Enables replay, debugging, and distributed execution

## Scaling

### Horizontal Scaling

- **Workers**: KEDA adds worker replicas per pool on EHDB feed lag
- **Server**: One server (a `replicas: 1` StatefulSet) coordinates all
  executions. A second replica would mint duplicate snowflake ids, and the
  server has no leader election.
- **Database**: PostgreSQL handles concurrent access to control-plane metadata
  and the current projection/read-model view; EHDB's event-log engine handles
  the authoritative event log, single-writer-per-shard with a total order

### Resource Pools

Configure worker pools for different resource types:
- CPU-intensive workloads
- GPU workloads (future) — classical ML training/inference, and
  post-processing of quantum computation results (see
  [Quantum Computation Workloads](#quantum-computation-workloads))
- I/O-bound operations
- Quantum workloads — via provider-backed tools (IBM Quantum Runtime API,
  NVIDIA cuQuantum/Qiskit Aer simulator); see
  [Quantum Networking Runner](/docs/examples/integrations/quantum_networking_runner)
  and [saqbit — quantum orchestration](https://saqbit.com/#docs) for the
  dedicated quantum-orchestration layer NoETL integrates with

## See Also

- [Deployment Modes](/docs/architecture/deployment_modes) - CLI, daemon and distributed, and how IaC state moves between them
- [Design Philosophy](/docs/getting-started/design-philosophy) - Architectural principles
- [Observability Services](/docs/reference/observability_services) - Monitoring stack
- [Multiple Workers](/docs/development/multiple_workers) - Worker configuration
- [Triage Model Selection](/docs/architecture/triage_model_selection) - Open-source SLM defaults and escalation tiers
- [EHDB](https://github.com/noetl/ehdb) - NoETL's internal event-log, projection, KV, and object storage substrate
- [EHDB Wiki](https://github.com/noetl/ehdb/wiki) - Live architecture, cutover status, and query-interface design
- [Vertex AI Triage Backend](/docs/architecture/vertex_ai_triage_backend) - Hybrid local/cloud LLM backend contract
- [Quantum Networking Runner](/docs/examples/integrations/quantum_networking_runner) - IBM Quantum / NVIDIA cuQuantum example
- [saqbit — quantum orchestration](https://saqbit.com/#docs) - Dedicated quantum-orchestration layer
