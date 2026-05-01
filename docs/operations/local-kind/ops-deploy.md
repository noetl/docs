---
title: Local Kind Deployment (Ops)
sidebar_label: Local Kind Deployment
sidebar_position: 1
---

# Local Kind Deployment (Ops)

This runbook deploys NoETL locally to a `kind` cluster using the `ops` automation playbooks.

## Prerequisites

- Podman machine is running (recommended: noetl-dev)
- `kubectl`, `kind`, and `noetl` CLI are installed
- Repos are present at:
  - `repos/ops`
  - `repos/noetl`

## Podman Setup (Recommended for macOS)

Podman provides the local container runtime used by the development playbooks.

### 1. Install and start Podman machine

```bash
# Install via Homebrew (if not already installed)
brew install podman kind kubectl

# Initialize and start podman machine (one-time init)
podman machine init --cpus 4 --memory 8192 --disk-size 200 --rootful noetl-dev
podman machine start noetl-dev

# Verify Podman machine is running
podman machine list
```

### 2. Validate kind host port mappings

kind port mappings are defined in repos/ops/ci/kind/config.yaml and are applied when creating the cluster.

If you change mappings, recreate cluster:

```bash
kind delete cluster --name noetl || true
kind create cluster --name noetl --config repos/ops/ci/kind/config.yaml
```

### 3. Access services from your host machine

With kind cluster mappings applied, services are accessible from host ports:

| Service | Host Port | Access URL |
|---------|-----------|------------|
| NoETL API | 8082 | `http://localhost:8082` |
| PostgreSQL | 54321 | `psql -h localhost -p 54321 -U noetl` |
| NATS Client | 32422 | `nats --server localhost:32422 ...` |
| NATS Monitoring | 32822 | `http://localhost:32822` |
| Grafana | 33000 | `http://localhost:33000` |
| Gateway UI | 38080 | `http://localhost:38080` |

**Note**: The kind cluster's `extraPortMappings` in `ci/kind/config.yaml` map container ports (30082, 30321, etc.) directly to host ports (8082, 54321, etc.).

---

## 1. Create or reset local cluster

**Important**: Ensure Podman machine is running:

```bash
podman machine list  # noetl-dev should be running
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
