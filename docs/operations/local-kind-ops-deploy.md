---
id: local-kind-ops-deploy
title: Local Kind Deployment (Ops)
sidebar_label: Local Kind Deployment
sidebar_position: 1
---

# Local Kind Deployment (Ops)

This runbook deploys NoETL locally to a `kind` cluster using the `ops` automation playbooks.

## Prerequisites

- Colima is running (instead of Docker Desktop for better performance on M-series Macs)
- `kubectl`, `kind`, and `noetl` CLI are installed
- Repos are present at:
  - `repos/ops`
  - `repos/noetl`

## Colima Setup (Recommended for macOS)

Colima is a lightweight container runtime that runs in a VM and is more efficient than Docker Desktop on Apple Silicon Macs. It includes built-in port forwarding for accessing services from your host machine.

### 1. Install and start Colima

```bash
# Install via Homebrew (if not already installed)
brew install colima docker kind kubectl

# Start Colima with persistent port forwarding
colima start

# Verify Colima is running
colima status
docker context use colima
```

### 2. Configure persistent port forwarding

Colima port forwarding is configured in `~/.colima/default/colima.yaml`. The file has been pre-configured with all necessary ports from the kind cluster configuration:

```yaml
# ~/.colima/default/colima.yaml
forwards:
  - guestPort: 8082
    hostPort: 8082      # NoETL API
  - guestPort: 54321
    hostPort: 54321     # PostgreSQL
  - guestPort: 32422
    hostPort: 32422     # NATS Client
  - guestPort: 32822
    hostPort: 32822     # NATS Monitoring
  - guestPort: 33000
    hostPort: 33000     # Grafana
  - guestPort: 39428
    hostPort: 39428     # VictoriaLogs
  - guestPort: 30123
    hostPort: 30123     # ClickHouse HTTP
  - guestPort: 30900
    hostPort: 30900     # ClickHouse Native
  - guestPort: 30633
    hostPort: 30633     # Qdrant HTTP
  - guestPort: 30634
    hostPort: 30634     # Qdrant gRPC
  - guestPort: 32888
    hostPort: 32888     # Superset
  - guestPort: 32999
    hostPort: 32999     # JupyterLab
  - guestPort: 32555
    hostPort: 32555     # Pagination Test
  - guestPort: 15000
    hostPort: 15000     # IBKR Gateway
  - guestPort: 38090
    hostPort: 38090     # Gateway API
  - guestPort: 38080
    hostPort: 38080     # Gateway UI
```

After updating the config, restart Colima:

```bash
colima stop
colima start --force-restart
```

### 3. Access services from your host machine

Once Colima is running with port forwarding configured, all kind cluster services are accessible via these host ports:

| Service | Host Port | Access URL |
|---------|-----------|------------|
| NoETL API | 8082 | `http://localhost:8082` |
| PostgreSQL | 54321 | `psql -h localhost -p 54321 -U noetl` |
| NATS Client | 32422 | `nats --server localhost:32422 ...` |
| NATS Monitoring | 32822 | `http://localhost:32822` |
| Grafana | 33000 | `http://localhost:33000` |
| Gateway UI | 38080 | `http://localhost:38080` |

**Note**: The kind cluster's `extraPortMappings` in `ci/kind/config.yaml` map container ports (30082, 30321, etc.) to host ports (8082, 54321, etc.). Colima's port forwarding then maps these host ports within the VM to your macOS machine.

---

## 1. Create or reset local cluster

**Important**: Ensure Colima is running and docker context is set to `colima`:

```bash
colima status  # Should show "running"
docker context show  # Should show "colima"
```

Create the cluster:

```bash
cd repos/ops
kind delete cluster --name noetl || true
noetl run automation/infrastructure/kind.yaml --runtime local --set action=create
kubectl config use-context kind-noetl
```

## 2. Deploy infrastructure dependencies

Deploy NATS first, then PostgreSQL:

```bash
cd repos/ops
noetl run automation/infrastructure/nats.yaml --runtime local --set action=deploy
noetl run automation/infrastructure/postgres.yaml --runtime local --set action=deploy
```

If Postgres deploy logs a missing `schema_ddl.sql` file, apply the schema configmap manually:

```bash
kubectl create configmap postgres-schema-ddl \
  --namespace postgres \
  --from-file=schema_ddl.sql.norun=../noetl/noetl/database/ddl/postgres/schema_ddl.sql \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n postgres rollout restart deployment/postgres
kubectl -n postgres rollout status deployment/postgres --timeout=240s
```

Create the worker secret expected by the local manifests:

```bash
kubectl -n noetl create secret generic gcs-credentials \
  --from-literal=gcs-key.json='{}' \
  --dry-run=client -o yaml | kubectl apply -f -
```

## 3. Build, load, and deploy NoETL

```bash
cd repos/ops
noetl run automation/development/noetl.yaml --runtime local --set action=build --set noetl_repo_dir=../noetl
noetl run automation/infrastructure/kind.yaml --runtime local --set action=image-load
noetl run automation/development/noetl.yaml --runtime local --set action=deploy --set noetl_repo_dir=../noetl
```

## 4. Verify deployment

```bash
kubectl -n nats get pods
kubectl -n postgres get pods
kubectl -n noetl get pods
curl -s http://localhost:8082/api/health
```

Expected health output:

```json
{"status":"ok"}
```

UI:

- `http://localhost:8082/execution`

## Troubleshooting

- `ImagePullBackOff`: local manifests use `imagePullPolicy: Never`. Build and load image into kind before deploy.
- Server restarts with DB errors: ensure Postgres pod is `Running` and `POSTGRES_HOST=postgres.postgres.svc.cluster.local` is reachable.
- Worker stuck on `Init:0/1`: ensure `gcs-credentials` secret exists in `noetl` namespace.
