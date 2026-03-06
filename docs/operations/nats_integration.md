---
sidebar_position: 5
title: NATS JetStream Integration
---

# NATS JetStream Integration

This page documents the concrete NATS setup used by NoETL across local kind and GKE deployments, including:

- where configuration lives (Helm/manifests/playbooks/code),
- which parameters are required,
- what environment variables are expected by Gateway, NoETL Server, and NoETL Worker,
- how to provision and verify in kind and GKE.

## Runtime Contract

NoETL uses JetStream for command notifications, while command state stays in the NoETL API/event model.

- Stream name: `NOETL_COMMANDS` (default)
- Subject: `noetl.commands` (default)
- Consumer: `noetl_worker_pool` (durable pull consumer)

Server publishes lightweight notifications:

```json
{
  "execution_id": 123,
  "event_id": 124,
  "command_id": "123:step:124",
  "step": "step",
  "server_url": "http://noetl.noetl.svc.cluster.local:8082"
}
```

Workers pull notifications, claim command execution through NoETL API, execute tools, and emit resulting events.

## Source of Truth: Files and Profiles

### Helm profiles (Kubernetes)

- NoETL chart values: [ops/automation/helm/noetl/values.yaml](https://github.com/noetl/ops/blob/main/automation/helm/noetl/values.yaml)
- NoETL chart templates:
  - [ops/automation/helm/noetl/templates/configmap-server.yaml](https://github.com/noetl/ops/blob/main/automation/helm/noetl/templates/configmap-server.yaml)
  - [ops/automation/helm/noetl/templates/configmap-worker.yaml](https://github.com/noetl/ops/blob/main/automation/helm/noetl/templates/configmap-worker.yaml)
- Gateway chart values: [ops/automation/helm/gateway/values.yaml](https://github.com/noetl/ops/blob/main/automation/helm/gateway/values.yaml)
- Gateway template env mapping: [ops/automation/helm/gateway/templates/deployment.yaml](https://github.com/noetl/ops/blob/main/automation/helm/gateway/templates/deployment.yaml)

### kind deployment profiles (manifest based)

- NATS manifests: [ops/ci/manifests/nats](https://github.com/noetl/ops/tree/main/ci/manifests/nats)
- NoETL manifests: [ops/ci/manifests/noetl](https://github.com/noetl/ops/tree/main/ci/manifests/noetl)
- Gateway manifests: [ops/ci/manifests/gateway](https://github.com/noetl/ops/tree/main/ci/manifests/gateway)

### Playbooks used for provisioning

- kind NATS infra: [ops/automation/infrastructure/nats.yaml](https://github.com/noetl/ops/blob/main/automation/infrastructure/nats.yaml)
- kind NoETL build/load/deploy: [ops/automation/development/noetl.yaml](https://github.com/noetl/ops/blob/main/automation/development/noetl.yaml)
- kind full bootstrap (includes NATS + NoETL + optional Gateway): [ops/automation/setup/bootstrap.yaml](https://github.com/noetl/ops/blob/main/automation/setup/bootstrap.yaml)
- GKE stack (IAP): [ops/automation/iap/gcp/deploy_gke_stack.yaml](https://github.com/noetl/ops/blob/main/automation/iap/gcp/deploy_gke_stack.yaml)
- GKE fresh stack profile: [ops/automation/gcp_gke/noetl_gke_fresh_stack.yaml](https://github.com/noetl/ops/blob/main/automation/gcp_gke/noetl_gke_fresh_stack.yaml)

### Runtime behavior in code

- NoETL NATS publisher/subscriber behavior:
  [noetl/noetl/core/messaging/nats_client.py](https://github.com/noetl/noetl/blob/main/noetl/core/messaging/nats_client.py)
- NoETL env variable model:
  [noetl/noetl/core/config.py](https://github.com/noetl/noetl/blob/main/noetl/core/config.py)
- Gateway env variable model:
  [gateway/src/config/gateway_config.rs](https://github.com/noetl/gateway/blob/main/src/config/gateway_config.rs)

## Required Parameters

### Infrastructure-level (playbook inputs)

Common GKE knobs (from `ops` playbooks):

- `nats_user`
- `nats_password`
- `nats_jetstream_file_size`
- `nats_jetstream_mem_size` (in some profiles, e.g. Autopilot)

These are used when Helm installs NATS (`nats/nats`) with JetStream enabled and auth users provisioned.

## Expected Environment Variables by Component

### NoETL Server

Primary NATS variables (from `NATS_*` aliases in `noetl/core/config.py`):

| Variable        | Required | Default                                   |
| --------------- | -------- | ----------------------------------------- |
| `NATS_URL`      | Yes      | `nats://nats.nats.svc.cluster.local:4222` |
| `NATS_STREAM`   | No       | `NOETL_COMMANDS`                          |
| `NATS_SUBJECT`  | No       | `noetl.commands`                          |
| `NATS_CONSUMER` | No       | `noetl_worker_pool`                       |
| `NATS_USER`     | No       | `noetl`                                   |
| `NATS_PASSWORD` | No       | `noetl`                                   |

In Helm, these are set in `config.server.*` in `automation/helm/noetl/values.yaml`.

### NoETL Worker

Worker uses the same `NATS_*` variables plus worker-specific pull tuning:

| Variable                                    | Required | Default                                             |
| ------------------------------------------- | -------- | --------------------------------------------------- |
| `NATS_URL`                                  | Yes      | `nats://noetl:noetl@localhost:30422` (code default) |
| `NATS_STREAM`                               | No       | `NOETL_COMMANDS`                                    |
| `NATS_SUBJECT`                              | No       | `noetl.commands`                                    |
| `NATS_CONSUMER`                             | No       | `noetl_worker_pool`                                 |
| `NOETL_WORKER_NATS_FETCH_TIMEOUT_SECONDS`   | No       | `30`                                                |
| `NOETL_WORKER_NATS_FETCH_HEARTBEAT_SECONDS` | No       | `5`                                                 |
| `NOETL_WORKER_NATS_MAX_ACK_PENDING`         | No       | `64`                                                |
| `NOETL_WORKER_NATS_MAX_DELIVER`             | No       | `1000`                                              |

In Helm, these are set in `config.worker.*` in `automation/helm/noetl/values.yaml`.

### Gateway

Gateway variables are read from `gateway_config.rs`.

| Variable                       | Required                     | Default                 |
| ------------------------------ | ---------------------------- | ----------------------- |
| `NATS_URL`                     | Yes                          | `nats://127.0.0.1:4222` |
| `NATS_UPDATES_SUBJECT_PREFIX`  | No                           | `playbooks.executions.` |
| `NATS_CALLBACK_SUBJECT_PREFIX` | No                           | `noetl.callbacks`       |
| `NATS_SESSION_BUCKET`          | No                           | `sessions`              |
| `NATS_SESSION_CACHE_TTL_SECS`  | No                           | `300`                   |
| `NATS_REQUEST_BUCKET`          | No                           | `requests`              |
| `NATS_REQUEST_TTL_SECS`        | No                           | `1800`                  |
| `CORS_ALLOWED_ORIGINS`         | Required for browser clients | localhost defaults only |

In Helm, these map from:

- `env.natsUrl` -> `NATS_URL`
- `env.natsUpdatesSubjectPrefix` -> `NATS_UPDATES_SUBJECT_PREFIX`

and CORS from `env.corsAllowedOrigins` -> `CORS_ALLOWED_ORIGINS`.

## Stream/Consumer Compatibility Rules

NoETL worker consumer uses:

- `deliver_policy=new`
- `ack_policy=explicit`
- pull subscription durable consumer

Stream created by NoETL runtime uses `retention=limits` (not `workqueue`) with in-memory storage and `max_age=3600`.

Important:

- If stream retention is changed to `workqueue`, consumer creation can fail with:
  `consumer must be deliver all on workqueue stream`.
- Keep stream subject aligned with `NATS_SUBJECT` (default `noetl.commands`).

## Provisioning with Playbooks

All commands below are run from the `ops` repository root.

### kind: minimal path (NATS + NoETL)

```bash
# 1) Deploy NATS
noetl run automation/infrastructure/nats.yaml \
  --runtime local \
  --set action=deploy

# 2) Build+load+deploy NoETL into kind
noetl run automation/development/noetl.yaml \
  --runtime local \
  --set action=redeploy \
  --set noetl_repo_dir=../noetl
```

### kind: full environment bootstrap

```bash
noetl run automation/setup/bootstrap.yaml --runtime local
```

Bootstrap includes PostgreSQL, NATS, NoETL, and (optionally) Gateway.

### GKE: standard IAP stack

```bash
noetl run automation/iap/gcp/deploy_gke_stack.yaml \
  --set project_id=<gcp-project-id> \
  --set deploy_nats=true \
  --set deploy_noetl=true \
  --set deploy_gateway=true
```

Useful NATS knobs:

```bash
--set nats_jetstream_size=5Gi
```

### GKE: fresh stack profile (more control)

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml \
  --set action=provision-deploy \
  --set project_id=<gcp-project-id> \
  --set nats_user=noetl \
  --set nats_password=noetl \
  --set nats_jetstream_file_size=5Gi
```

This profile wires NATS credentials into both NoETL (`config.server.NATS_URL`, `config.worker.NATS_URL`) and Gateway (`env.natsUrl`).

## Verification Checklist

```bash
# NATS pods
kubectl -n nats get pods

# Stream and consumers
kubectl -n nats exec deploy/nats-box -- \
  nats --server nats://noetl:noetl@nats.nats.svc.cluster.local:4222 stream info NOETL_COMMANDS
kubectl -n nats exec deploy/nats-box -- \
  nats --server nats://noetl:noetl@nats.nats.svc.cluster.local:4222 consumer ls NOETL_COMMANDS

# NoETL components
kubectl -n noetl get deploy noetl-server noetl-worker

# Gateway env spot-check
kubectl -n gateway get deploy gateway -o yaml | rg \"NATS_URL|NATS_UPDATES_SUBJECT_PREFIX|CORS_ALLOWED_ORIGINS\"
```

## Troubleshooting

- Symptom: browser shows CORS `Failed to fetch` on gateway auth.
  Check if backend is returning 5xx via proxy/CDN and missing CORS headers on error response.
- Symptom: `nats: no response from stream` in NoETL server.
  Verify stream exists and subject matches `NATS_SUBJECT`.
- Symptom: worker crash-loop with `deliver all on workqueue stream`.
  Recreate `NOETL_COMMANDS` with `retention=limits` and restart NoETL server/workers.
