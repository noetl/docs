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
| `NOETL_POSTGRES_POOL_MIN_SIZE` | `2` | Core DB pool minimum |
| `NOETL_POSTGRES_POOL_MAX_SIZE` | `32` | Core DB pool maximum (code fallback; Helm sets `12`) |
| `NOETL_POSTGRES_POOL_MAX_WAITING` | `256` | DB acquire queue limit |
| `NOETL_POSTGRES_POOL_TIMEOUT_SECONDS` | `30` | DB acquire timeout |
| `NOETL_BG_POOL_MIN_SIZE` | `1` | Background-task pool minimum (checkpointer, sweeper, reaper) |
| `NOETL_BG_POOL_MAX_SIZE` | `4` | Background-task pool maximum — kept low to leave headroom on the main pool |
| `NOETL_POSTGRES_STATEMENT_TIMEOUT_MS` | `60000` | Server session `statement_timeout` (ms) |
| `NOETL_POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | `45000` | Server session `idle_in_transaction_session_timeout` (ms) |
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
| `NOETL_POSTGRES_POOL_MIN_SIZE` | `1` | DB pool minimum (shared by core + tool pools) |
| `NOETL_POSTGRES_POOL_MAX_SIZE` | `6` | DB pool maximum — see [Database Pool Handling](#database-pool-handling) for the two-pool architecture |
| `NOETL_POSTGRES_POOL_MAX_WAITING` | `50` | DB acquire queue limit (tool-pool fallback) |
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

## Database Pool Handling

NoETL maintains **two distinct Postgres pools per process**, both controlled by the same set of `NOETL_POSTGRES_POOL_*` env vars but with different fallback defaults. Understanding which pool is active on which component is critical for throughput tuning, especially for playbooks that drive many parallel `kind: postgres` steps.

### The two pools

| Pool | Lives in | Used by | Source | Code-fallback max |
| --- | --- | --- | --- | --- |
| **Core DB pool** | server, worker | Engine, event/command writes, state reads, server API handlers | `noetl/core/db/pool.py` | `32` |
| **Postgres tool pool** | worker | Every `kind: postgres` step (playbook SQL — `command:` / `query:`) | `noetl/tools/postgres/pool.py` | `6` |

Both pools read the **same env var names** (`NOETL_POSTGRES_POOL_MAX_SIZE`, `NOETL_POSTGRES_POOL_MIN_SIZE`, `NOETL_POSTGRES_POOL_MAX_WAITING`, `NOETL_POSTGRES_POOL_TIMEOUT_SECONDS`). Setting the env var applies to **both pools** on the host where it is set. If the env var is unset, each pool falls back to its own code default — **32 for core, 6 for tool** — which is why an unconfigured worker ends up with a very small effective cap on playbook SQL concurrency.

In addition, the **server** runs a dedicated **background pool** (`NOETL_BG_POOL_MIN_SIZE` / `NOETL_BG_POOL_MAX_SIZE`, default `1..4`) used exclusively by the checkpointer, sweeper, and expired-claim reaper. This pool is intentionally kept small so background maintenance cannot starve the main request path.

### Why the distinction matters

A playbook step like:

```yaml
loop:
  in: '{{ claim_patients.rows }}'
  iterator: patient
  spec:
    mode: parallel
    max_in_flight: 100
tool:
  - name: save_page
    kind: postgres
    auth: pg_k8s
    command: |
      INSERT INTO ... VALUES ...
```

dispatches up to 100 parallel `kind: postgres` invocations on the workers. Each invocation acquires a connection from the **Postgres tool pool** on the worker that runs it. If that pool is capped at the default `6`, only 6 of the 100 iterations can hold a connection at once — the remaining 94 queue on `NOETL_POSTGRES_POOL_MAX_WAITING` (fallback `50` for the tool pool) and either serialize or time out.

Symptoms of a too-small tool pool:

- Loop wall-clock looks linear instead of parallel even when `max_in_flight` is high.
- Worker logs show repeated `pool timeout` / `wait queue full` entries for playbook SQL.
- Postgres `pg_stat_activity` shows far fewer active worker sessions than `max_in_flight` would predict.
- `pg_stat_activity` on the server side looks healthy while the worker side is idle — the bottleneck is the client-side pool, not the database.

### Recommended sizing

| Scenario | Server `NOETL_POSTGRES_POOL_MAX_SIZE` | Worker `NOETL_POSTGRES_POOL_MAX_SIZE` | Notes |
| --- | --- | --- | --- |
| Small dev / smoke tests | `12` | `8` | Helm defaults. Fine for single-loop fixtures. |
| Functional regression (e.g. hello-world, cuda-q) | `16` | `16` | Matches typical worker `NOETL_WORKER_MAX_INFLIGHT_COMMANDS`. |
| Parallel-loop load tests (e.g. `test_pft_flow`) | `32`–`48` | `32`–`48` | Worker pool should be ≥ loop `max_in_flight` used by hot `kind: postgres` steps. |
| GKE production-scale | `64`+ | `48`–`64` | Must stay ≤ Postgres `max_connections` minus headroom for observability + admin. |

Rules of thumb:

1. The **worker** pool (tool pool) governs playbook SQL concurrency. Size it to match the highest `max_in_flight` of a parallel loop whose iterator body contains a `kind: postgres` step. If a playbook has a loop with `max_in_flight: 100` driving a Postgres insert, at least 32–48 is prudent (writes overlap; not every iteration holds the connection for the full wall-clock).
2. The **server** pool governs engine throughput (event writes, command projection, status reads). Under heavy parallel loops the server sees a proportional number of `command.issued` / `event.result` writes; keep it at least as large as the worker pool.
3. `NOETL_BG_POOL_MAX_SIZE` should remain small (≤ 4). Raising it does not help under load and risks starving the main pool when the checkpointer/sweeper run.
4. **Total concurrent connections to Postgres** = `(server pool × server replicas) + (worker pool × worker replicas) + bg pool + external clients`. Keep total ≤ `max_connections - 10–20` headroom. When running PgBouncer transaction-mode, pool limits are per-client rather than per-backend.

### Applying pool sizing

**Ops playbook (preferred for local + GKE):**

```bash
noetl run automation/development/noetl.yaml --runtime local \
  --set action=redeploy \
  --set noetl_postgres_pool_max_size=48
```

**Direct `kubectl set env` (quick patch without redeploy):**

```bash
kubectl set env deployment/noetl-server -n noetl NOETL_POSTGRES_POOL_MAX_SIZE=48
kubectl set env deployment/noetl-worker -n noetl \
  NOETL_POSTGRES_POOL_MAX_SIZE=48 \
  NOETL_POSTGRES_POOL_MAX_WAITING=256
```

Rolling restart is automatic. Both the core pool and the tool pool on that process pick up the new value on startup.

**Helm values:**

```yaml
# ops/automation/helm/noetl/values.yaml
config:
  server:
    NOETL_POSTGRES_POOL_MAX_SIZE: "48"
    NOETL_BG_POOL_MAX_SIZE: "4"
  worker:
    NOETL_POSTGRES_POOL_MAX_SIZE: "48"
    NOETL_POSTGRES_POOL_MAX_WAITING: "256"
```

### Verifying the pool is live

```bash
kubectl exec -n noetl deploy/noetl-worker -- printenv | grep NOETL_POSTGRES_POOL
# NOETL_POSTGRES_POOL_MAX_SIZE=48
# NOETL_POSTGRES_POOL_MAX_WAITING=256
```

On the Postgres side, confirm the session count rises when the pool is in use:

```sql
SELECT application_name, state, COUNT(*)
FROM pg_stat_activity
WHERE application_name LIKE 'noetl%'
GROUP BY 1, 2;
```

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
