---
sidebar_position: 3
title: Architecture
description: NoETL system architecture and components
---

# Architecture

NoETL uses a server-worker architecture for distributed workflow execution.

## Component Overview

![NoETL Components](/img/noetl-components.png)

## Components

### Gateway

Rust-based API gateway for external clients:
- Exposes GraphQL API for playbook execution
- Provides REST API for Auth0 authentication (`/api/auth/*`)
- Session validation middleware with NATS K/V caching
- Pure gateway design - no direct database connections
- All data access through Control Plane API
- NATS K/V for fast session lookups (sub-millisecond)
- Future: WebSocket subscriptions via NATS for live updates

**Session Caching:** Gateway checks NATS K/V for cached sessions before calling auth playbooks. On cache miss, playbooks validate from PostgreSQL and refresh the cache.

### NoETL Control Plane

Central coordination service:
- Exposes REST APIs for catalog, credentials, executions, and events
- Schedules and supervises workflow executions
- Publishes task notifications to NATS JetStream
- Receives execution events from workers
- Manages retries and backoff policies
- Reconstructs workflow state from event table
- Used by CLIs, UIs, and integrations

### Event Store and Projections

NoETL's current event-sourced runtime uses PostgreSQL as the authoritative
event and projection store:

- `noetl.event` is the append-only execution history.
- Projection tables such as executions, commands, stages, frames, and runtime
  state are rebuildable from events.
- Replay validation reads the event stream and checks projected runtime state
  without depending on worker memory.
- NATS JetStream is used for command notification and worker delivery, not as
  the authoritative event store in the current implementation.

The broader event-store abstraction described in the architecture roadmap keeps
the same separation of concerns but allows future deployments to bind the event
stream to NATS JetStream, Kafka, Pub/Sub, Event Hubs, Kinesis, or MSK, and bind
projection state to PostgreSQL or cloud-native/document/analytic stores. The DSL
and playbooks stay backend-neutral; infrastructure configuration selects the
adapters.

### Worker Pools

Stateless background executors:
- Subscribe to NATS JetStream for task notifications
- Retrieve task details via Control Plane API
- Run workflow steps and tools (HTTP, SQL, Python, etc.)
- Report events back via Control Plane API
- Scale horizontally based on load
- Isolated execution environments

### NATS JetStream

Message broker for task distribution:
- Control Plane publishes task notifications to NATS streams
- Workers subscribe and acknowledge messages
- Messages contain pointers to Control Plane API for task details
- Durable subscriptions ensure no task loss
- Supports multiple worker pools and load balancing

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
- **Catalog**: Playbooks, versions, schemas, tool definitions
- **Credentials**: Connection configs and tokens with scoped access

### Event Bus and Telemetry

Observability infrastructure:
- Every step emits structured events (start/finish/errors, durations)
- Events exported to analytics backends (ClickHouse, VictoriaMetrics)
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
│   Web UI    │────▶│   Gateway   │────▶│ Control Plane │────▶│    NATS     │
│  (GraphQL)  │     │   (Rust)    │     │   (FastAPI)   │     │ JetStream   │
└─────────────┘     └─────────────┘     └───────┬───────┘     └──────┬──────┘
                                                │                    │
┌─────────────┐                                 │              ┌─────▼─────┐
│   CLI/API   │─────────────────────────────────┘              │  Workers  │
│  (Direct)   │                                 │◀─────────────│ (Execute) │
└─────────────┘                                 │  (events)    └───────────┘
                                                ▼                    
                                        ┌─────────────┐     
                                        │  PostgreSQL │     
                                        │  (Events)   │     
                                        └─────────────┘     
```

1. **Web UI** sends GraphQL requests to Gateway
2. **Gateway** authenticates and forwards to Control Plane API
3. **CLI/API** can also call Control Plane directly
4. **Control Plane** validates, creates execution, publishes task to NATS
5. **Workers** receive NATS message with task pointer
6. **Workers** fetch task details from Control Plane API
7. **Workers** execute steps and report events to Control Plane API
8. **Control Plane** stores events in PostgreSQL `noetl.event` table
9. **Control Plane** monitors events to determine next steps in workflow
10. **Large results** are stored by reference; events carry ResultRef metadata
11. **Cursor frames** may attach an optional Arrow IPC shared-memory hint for
    same-node consumers, while durable storage remains the fallback

## Database Schema

The NoETL PostgreSQL schema is intentionally simple - no queue tables:

| Table | Purpose |
|-------|---------|
| `catalog` | Playbook definitions (path, version, content) |
| `event` | Execution events (status, results, errors) |
| `credential` | Encrypted credentials |
| `keychain` | Runtime token cache with TTL |
| `transient` | Execution-scoped variables |
| `runtime` | Worker pool and server registration |
| `schedule` | Cron/interval scheduled playbooks |

**Control loop**: Control Plane analyzes `event` table to reconstruct execution state and determine next steps, then publishes tasks to NATS.

## Communication Patterns

### Control Plane → NATS → Worker

Task distribution via NATS JetStream:
1. Control Plane publishes task notification to NATS stream
2. Message contains execution_id and task pointer (not full payload)
3. Worker subscribes, receives message, acknowledges
4. Worker calls Control Plane API to get full task context
5. Worker executes and reports events to Control Plane API

### Event-Driven State

All execution state is persisted as events in PostgreSQL:
- Server reconstructs workflow state from `noetl.event` table
- Determines which steps completed, which are pending
- Publishes next tasks to NATS based on workflow graph
- Enables replay, debugging, and distributed execution

## Scaling

### Horizontal Scaling

- **Workers**: Add more worker replicas for throughput
- **Server**: Single server coordinates all executions
- **Database**: PostgreSQL handles concurrent access

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

- [Design Philosophy](/docs/getting-started/design-philosophy) - Architectural principles
- [Observability Services](/docs/reference/observability_services) - Monitoring stack
- [Multiple Workers](/docs/development/multiple_workers) - Worker configuration
- [Triage Model Selection](/docs/architecture/triage_model_selection) - Open-source SLM defaults and escalation tiers
- [Vertex AI Triage Backend](/docs/architecture/vertex_ai_triage_backend) - Hybrid local/cloud LLM backend contract
- [Quantum Networking Runner](/docs/examples/integrations/quantum_networking_runner) - IBM Quantum / NVIDIA cuQuantum example
- [saqbit — quantum orchestration](https://saqbit.com/#docs) - Dedicated quantum-orchestration layer
