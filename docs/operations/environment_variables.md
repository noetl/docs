---
sidebar_position: 6
title: Environment Variables
---

# Environment Variables

This is the dedicated runtime env-var reference for NoETL components:

- NoETL Server
- NoETL Worker
- Rust Worker Pool
- Gateway

## Source Of Truth

- NoETL Python settings and runtime behavior:
  - `noetl/core/config.py`
  - `noetl/core/storage/result_store.py`
- Ops Helm values used in Kubernetes deployments:
  - `ops/automation/helm/noetl/values.yaml`
  - `ops/automation/helm/gateway/values.yaml`
- Ops playbooks that apply/override values:
  - `ops/automation/deployment/noetl-stack.yaml`
  - `ops/automation/gcp_gke/noetl_gke_fresh_stack.yaml`

## NoETL Server

Configured in Helm under `config.server`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOETL_RUN_MODE` | `server` | Process mode |
| `NOETL_HOST` | `0.0.0.0` | API bind host |
| `NOETL_PORT` | `8082` | API port |
| `NOETL_SERVER_URL` | `http://noetl.noetl.svc.cluster.local:8082` | Internal server URL |
| `NOETL_ENABLE_UI` | `true` | Enable API UI routes |
| `NOETL_DISABLE_METRICS` | `true` | Toggle metrics emission |
| `NOETL_SERVER_METRICS_INTERVAL` | `60` | Metrics publish interval (seconds) |
| `NATS_URL` | `nats://noetl:noetl@nats.nats.svc.cluster.local:4222` | NATS connection URL |
| `NATS_STREAM` | `NOETL_COMMANDS` | JetStream stream name |
| `NATS_SUBJECT` | `noetl.commands` | JetStream subject |
| `NATS_CONSUMER` | `noetl_worker_pool` | Durable consumer name |
| `POSTGRES_HOST` | `postgres.postgres.svc.cluster.local` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `NOETL_POSTGRES_POOL_MIN_SIZE` | `2` | DB pool minimum |
| `NOETL_POSTGRES_POOL_MAX_SIZE` | `12` | DB pool maximum |
| `NOETL_POSTGRES_POOL_MAX_WAITING` | `200` | DB acquire queue limit |
| `NOETL_POSTGRES_POOL_TIMEOUT_SECONDS` | `30` | DB acquire timeout |
| `NOETL_TEMPSTORE_MAX_REF_CACHE_ENTRIES` | `50000` | Max in-memory TempRef metadata entries |
| `NOETL_TEMPSTORE_MAX_MEMORY_CACHE_ENTRIES` | `20000` | Max in-memory temp payload entries |

## NoETL Worker

Configured in Helm under `config.worker`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOETL_RUN_MODE` | `worker` | Process mode |
| `NOETL_SERVER_URL` | `http://noetl.noetl.svc.cluster.local:8082` | API endpoint for command execution |
| `NATS_URL` | `nats://noetl:noetl@nats.nats.svc.cluster.local:4222` | NATS connection URL |
| `NATS_STREAM` | `NOETL_COMMANDS` | JetStream stream name |
| `NATS_SUBJECT` | `noetl.commands` | JetStream subject |
| `NATS_CONSUMER` | `noetl_worker_pool` | Durable consumer name |
| `NOETL_WORKER_NATS_FETCH_TIMEOUT_SECONDS` | `30` | Pull fetch timeout |
| `NOETL_WORKER_NATS_FETCH_HEARTBEAT_SECONDS` | `5` | Pull fetch heartbeat |
| `NOETL_WORKER_NATS_MAX_ACK_PENDING` | `64` | Consumer ack-pending limit |
| `NOETL_WORKER_NATS_MAX_DELIVER` | `1000` | Consumer max delivery retries |
| `NOETL_WORKER_MAX_INFLIGHT_COMMANDS` | `8` | Inflight command concurrency |
| `NOETL_WORKER_MAX_INFLIGHT_DB_COMMANDS` | `3` | Inflight DB-heavy command cap |
| `NOETL_POSTGRES_POOL_MIN_SIZE` | `1` | DB pool minimum |
| `NOETL_POSTGRES_POOL_MAX_SIZE` | `8` | DB pool maximum |
| `NOETL_POSTGRES_POOL_MAX_WAITING` | `100` | DB acquire queue limit |
| `NOETL_POSTGRES_POOL_TIMEOUT_SECONDS` | `30` | DB acquire timeout |
| `NOETL_INLINE_MAX_BYTES` | `65536` | Inline result payload threshold |
| `NOETL_PREVIEW_MAX_BYTES` | `1024` | Preview payload size |
| `NOETL_DEFAULT_STORAGE_TIER` | `kv` | Default result storage tier |
| `NOETL_TEMPSTORE_MAX_REF_CACHE_ENTRIES` | `50000` | Max in-memory TempRef metadata entries |
| `NOETL_TEMPSTORE_MAX_MEMORY_CACHE_ENTRIES` | `20000` | Max in-memory temp payload entries |

## Rust Worker Pool

Configured in Helm under `config.workerPool`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKER_POOL_NAME` | `worker-rust-pool` | Worker pool identity |
| `NOETL_SERVER_URL` | `http://noetl.noetl.svc.cluster.local:8082` | API endpoint |
| `NATS_URL` | `nats://noetl:noetl@nats.nats.svc.cluster.local:4222` | NATS connection URL |
| `NATS_STREAM` | `NOETL_COMMANDS` | JetStream stream name |
| `NATS_CONSUMER` | `noetl_worker_pool` | Durable consumer name |
| `WORKER_HEARTBEAT_INTERVAL` | `15` | Heartbeat interval (seconds) |
| `WORKER_MAX_CONCURRENT` | `4` | Max concurrent jobs per pool pod |
| `RUST_LOG` | `info,worker_pool=debug,noetl_tools=debug` | Rust log filter |

## Gateway

Configured in Helm under `env` (`ops/automation/helm/gateway/values.yaml`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROUTER_PORT` | `8090` | Gateway listen port |
| `NOETL_BASE_URL` | `http://noetl.noetl.svc.cluster.local:8082` | Upstream NoETL API |
| `NATS_URL` | `nats://noetl:noetl@nats.nats.svc.cluster.local:4222` | NATS connection URL |
| `NATS_UPDATES_SUBJECT_PREFIX` | `playbooks.executions.` | Execution updates subject prefix |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3001` | Browser origins allow-list |
| `AUTH_BYPASS` | `false` | Disable auth checks (dev only) |
| `PUBLIC_URL` | empty | Public URL used in redirects/callbacks |
| `RUST_LOG` | `info,gateway=debug` | Rust log filter |

## TempStore Cache Controls

`NOETL_TEMPSTORE_MAX_REF_CACHE_ENTRIES` and `NOETL_TEMPSTORE_MAX_MEMORY_CACHE_ENTRIES` bound TempStore in-memory caches to avoid unbounded growth.

- Larger values improve hot-cache hit rates but increase process memory usage.
- Smaller values reduce memory footprint but may increase backend reads/deletes.

## Playbook Overrides

### Local kind stack deploy

```bash
noetl run automation/deployment/noetl-stack.yaml --runtime local \
  --set action=deploy \
  --set noetl_tempstore_max_ref_cache_entries=50000 \
  --set noetl_tempstore_max_memory_cache_entries=20000
```

### GKE fresh stack deploy

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml --runtime local \
  --set action=deploy \
  --set project_id=<project-id> \
  --set noetl_tempstore_max_ref_cache_entries=50000 \
  --set noetl_tempstore_max_memory_cache_entries=20000
```

### Direct Helm override (any environment)

```bash
helm upgrade --install noetl automation/helm/noetl \
  --namespace noetl \
  --set config.server.NOETL_TEMPSTORE_MAX_REF_CACHE_ENTRIES=50000 \
  --set config.server.NOETL_TEMPSTORE_MAX_MEMORY_CACHE_ENTRIES=20000 \
  --set config.worker.NOETL_TEMPSTORE_MAX_REF_CACHE_ENTRIES=50000 \
  --set config.worker.NOETL_TEMPSTORE_MAX_MEMORY_CACHE_ENTRIES=20000
```
