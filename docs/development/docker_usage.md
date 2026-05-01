# Local Container Usage (Podman + NoETL Playbooks)

This page replaces legacy Docker/Make workflows with the current local development approach:

- Podman as the container runtime
- kind for local Kubernetes
- noetl playbooks for build, load, deploy, and status

## Overview

For local development, run NoETL through automation playbooks in repos/ops:

1. Build container image with Podman
2. Load image into kind cluster
3. Deploy server and workers with Kubernetes manifests
4. Verify health and iterate with a single redeploy command

## Prerequisites

- Podman machine running (recommended name: noetl-dev)
- kind
- kubectl
- noetl CLI
- repos/ops and repos/noetl checked out

## Quick Start

From ai-meta root:

```bash
# Full local cycle (build -> load -> deploy -> status)
noetl run repos/ops/automation/development/noetl.yaml --runtime local \
  --set action=redeploy --set noetl_repo_dir=repos/noetl

# Verify health
curl -s http://localhost:8082/api/health
```

Expected output includes:

- NoETL API at http://localhost:8082
- noetl-server deployment ready
- noetl-worker deployment ready

## Common Actions

```bash
# Build image only
noetl run repos/ops/automation/development/noetl.yaml --runtime local \
  --set action=build --set noetl_repo_dir=repos/noetl

# Load image to kind only
noetl run repos/ops/automation/development/noetl.yaml --runtime local \
  --set action=load --set noetl_repo_dir=repos/noetl

# Deploy only
noetl run repos/ops/automation/development/noetl.yaml --runtime local \
  --set action=deploy --set noetl_repo_dir=repos/noetl

# Status
noetl run repos/ops/automation/development/noetl.yaml --runtime local \
  --set action=status --set noetl_repo_dir=repos/noetl
```

## Podman Notes

- The playbook handles local image naming differences between local/... and localhost/local/... automatically.
- If kind was created before port mapping changes, recreate the cluster to apply new mappings.

## Run Playbooks (No Containers Required)

For DSL/playbook development and tests, use local runtime directly:

```bash
# Run a file-based playbook locally
noetl run repos/noetl/tests/fixtures/playbooks/hello_world/hello_world.yaml -r local -v

# Register fixtures for distributed runtime
noetl register playbook --directory repos/noetl/tests/fixtures/playbooks
```

## Troubleshooting

### ErrImageNeverPull

Root cause is usually image name mismatch or missing kind load.

```bash
# Re-run load and deploy
noetl run repos/ops/automation/development/noetl.yaml --runtime local --set action=load --set noetl_repo_dir=repos/noetl
noetl run repos/ops/automation/development/noetl.yaml --runtime local --set action=deploy --set noetl_repo_dir=repos/noetl
```

### Podman machine is not running

```bash
podman machine start noetl-dev
```

### API not reachable

```bash
kubectl -n noetl get pods
kubectl -n noetl get svc
curl -s http://localhost:8082/api/health
```

## Next Steps

- [Automation Playbooks](./automation_playbooks.md)
- [Kind Kubernetes](./kind_kubernetes.md)
- [Local Kind Deployment (Ops)](/docs/operations/local-kind/ops-deploy)
