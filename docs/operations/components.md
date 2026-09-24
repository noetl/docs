# NoETL Platform Components

This document describes all components in the NoETL platform, their dependencies, and how they interact with each other.

## Architecture Overview

The NoETL platform consists of multiple interconnected components that work together to provide a complete data processing and observability solution in Kubernetes.

## All Components

- PostgreSQL: Running in postgres namespace
- NoETL Server: Accessible at http://localhost:8082 (kind maps nodePort 30082 -> host 8082)
- NoETL Workers: the deployed pools are `worker-rust-pool`, `worker-system-pool` and the `cmdbus-writer` (which hosts the EHDB bus)
- EHDB feed: the command bus — the server publishes task notifications, workers claim them per shard
- NATS JetStream: still deployed locally, but **no longer an internal transport** — it backs the user-facing `nats` tool kind and `subscription` sources. See operations/nats_integration.md
- Runtime reaper / doctor: monitoring-callable self-healing surface around the server-side command reaper. See operations/runtime-reaper-doctor.md
- Grafana: Accessible at http://localhost:33000 (admin/admin) (kind maps nodePort 30300 -> host 33000)
- VictoriaMetrics: not nodePort-mapped in kind; reach `/vmui/` with `kubectl port-forward`
- VictoriaLogs: Accessible at http://localhost:39428 (kind maps nodePort 30428 -> host 39428)
- Dashboards: Both NoETL server and worker dashboards provisioned
- Datasources: Grafana datasources ConfigMap found and provisioned

## Architecture Diagram

```
                            +---------------------+
                            |     PostgreSQL      |
                            |  (metadata, jobs)   |
                            +----------^----------+
                                       |
                               reads/writes via
                                       |
+----------------------+       +-------+--------+        +----------------------+
|   VictoriaMetrics    |<------|   NoETL Server |---+--->|    NoETL Workers     |
| (metrics storage)    |  scrapes  |  (API & UI) |   \   | (worker-rust-pool,   |
+----------^-----------+        |               |    \   |  worker-system-pool) |
           |                    |               |     \  +----------^-----------+
           |                emits|metrics & logs|      \            |
           |                    v               v       \           |
           |            +---------------+   +---------------+        |
           |            |  Vector/Logs  |-->|  VictoriaLogs |<-------+
           |            |  (agents)     |   |  (logs store) |
           |            +---------------+   +---------------+
           |
           +---------------------> Grafana <-------------------------+
                                  (dashboards & alerting)
                          reads from VM + VictoriaLogs datasources

                            command notifications
                                        |
                                        v
                                   +----------+
                                   |   EHDB   |
                                   |   feed   |
                                   +----------+
                                        ^
                                   publish / claim
```

Legend:
- NoETL Server communicates with Workers (task scheduling, status updates). Both write job/task metadata to PostgreSQL.
- The EHDB feed carries command notifications: the Server publishes and Workers claim per shard. NATS JetStream previously held this role and no longer does.
- Metrics are scraped by VictoriaMetrics (via PodMonitor/PodScrape). Logs are shipped by agents (Vector) to VictoriaLogs.
- Grafana reads from VictoriaMetrics and VictoriaLogs and shows pre-provisioned dashboards and datasources.

## Component Responsibilities & Dependencies

### 1. PostgreSQL
- Purpose: System-of-record for metadata (pipelines, jobs, tasks, results, scheduling state).
- Depends on: Persistent storage (Kubernetes PVC or external DB).
- Used by: NoETL Server.

### 2. NoETL Server
- Purpose: HTTP API/UI, orchestration, scheduling, and coordination of workers.
- Depends on:
  - PostgreSQL (read/write job and pipeline metadata)
  - Kubernetes (service discovery and worker orchestration)
  - Observability stack for metrics/logs export
- Provides:
  - API at http://localhost:8082
  - Metrics endpoint scraped by VictoriaMetrics
  - Logs shipped to VictoriaLogs via Vector agents

### 3. NoETL Workers
- Purpose: Execute tasks; report status and metrics.
- Depends on:
  - NoETL Server (work assignment, heartbeats)
  - Container runtime (plus GPU drivers for any GPU-designated pool)
- Emits:
  - Metrics scraped by VictoriaMetrics
  - Logs shipped to VictoriaLogs

### 4. EHDB feed (command bus)
- Purpose: Task distribution — command notifications carrying a pointer, not the payload.
- Depends on:
  - The `cmdbus-writer` workload, which hosts the durable per-shard log
- Used by:
  - NoETL Server (publishes)
  - NoETL Workers (claim + acknowledge per shard)
- Replaced NATS JetStream in this role; see [Architecture](/docs/getting-started/architecture).

### 4b. NATS JetStream
- Purpose: **No longer an internal transport.** It remains deployed by the local
  bootstrap and serves playbook-facing use: the `nats` tool kind and NATS-sourced
  `subscription` specs.
- Configuration hints:
  - `NATS_URL` env var (e.g., `nats://noetl:noetl@nats.nats.svc.cluster.local:4222`)
  - See detailed integration: operations/nats_integration.md

### 5. VictoriaMetrics
- Purpose: Time-series metrics storage and query (PromQL-compatible).
- Depends on:
  - PodMonitor/PodScrape configs to discover Server and Worker metrics endpoints
- Used by:
  - Grafana (dashboards)

### 6. VictoriaLogs
- Purpose: Centralized logs storage and query.
- Depends on:
  - Log shippers (Vector agents) to forward container logs
- Used by:
  - Grafana (Explore/log panels)

### 7. Grafana
- Purpose: Visualization, dashboards, alerts.
- Depends on:
  - Datasource provisioning for VictoriaMetrics and VictoriaLogs
  - Dashboard provisioning for NoETL Server and Workers
- Endpoints:
  - http://localhost:33000 (admin/admin)

### 8. Provisioned Dashboards and Datasources
- Dashboards:
  - NoETL Server dashboard
  - NoETL Worker dashboard
- Datasources:
  - VictoriaMetrics (metrics)
  - VictoriaLogs (logs)

## Operational Notes
- Namespaces: PostgreSQL runs in the `postgres` namespace; other components typically run in a unified platform namespace (e.g., `noetl-platform`).
- Health checks: Use the unified make targets (e.g., `make unified-health-check`) to validate all components are up and endpoints are reachable.
- Troubleshooting:
  - Metrics scraping: see `ci/manifests/noetl/gmp/podmonitoring-noetl.yaml` (noetl/ops)
  - Writer metrics monitor: see `ci/manifests/noetl/gmp/podmonitoring-cmdbus-writer.yaml` (noetl/ops)
  - Logs shippers: see `ci/vmstack/vector-values.yaml` (noetl/ops)
  - VictoriaMetrics stack in kind: [Local kind VM stack](/docs/observability/local_kind_vm_stack)
  - NATS setup and flows: [NATS integration](/docs/operations/nats_integration)
