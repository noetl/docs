---
id: local-kind-ops-deploy
title: Local Kind Deployment (Ops)
sidebar_label: Local Kind Deployment
sidebar_position: 1
---

# Local Kind Deployment (Ops)

This runbook deploys NoETL locally to a `kind` cluster using the `ops` automation playbooks.

## Prerequisites

- Docker Desktop is running
- `kubectl`, `kind`, and `noetl` CLI are installed
- Repos are present at:
  - `repos/ai-meta/repos/ops`
  - `repos/ai-meta/repos/noetl`

## 1. Create or reset local cluster

```bash
cd repos/ai-meta/repos/ops
kind delete cluster --name noetl || true
noetl run automation/infrastructure/kind.yaml --runtime local --set action=create
kubectl config use-context kind-noetl
```

## 2. Deploy infrastructure dependencies

Deploy NATS first, then PostgreSQL:

```bash
cd repos/ai-meta/repos/ops
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
cd repos/ai-meta/repos/ops
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
