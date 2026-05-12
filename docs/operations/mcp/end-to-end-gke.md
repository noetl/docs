---
title: MCP End-to-End on GKE
sidebar_label: MCP End-to-End (GKE)
sidebar_position: 4
---

# MCP End-to-End on GKE

Deploy the same NoETL + MCP architecture you ran locally
([MCP End-to-End on Local Kind](./end-to-end-local-kind.md)) onto a
Google Kubernetes Engine cluster.

The shape of the deployment is identical:

- noetl-server + noetl-worker in the `noetl` namespace
- noetl-gui in the `gui` namespace
- kubernetes-mcp-server in the `mcp` namespace, deployed *through*
  noetl's lifecycle dispatch (so the catalog browser can manage it)
- postgres + nats as state stores

What changes for GKE:

- the cluster doesn't necessarily expose itself to the public
  internet; we use port-forwards or an Ingress with IAP
- container runtime is GKE-managed (no podman); local source
  builds aren't useful, we always pull from `ghcr.io/noetl/...`
- persistence uses GCP-managed storage (PD, optionally Cloud SQL)
  rather than hostPath mounts
- the gateway component (Rust auth proxy) is recommended as
  the front door so the GUI's session-token flow works without
  IP-based access controls

## Prerequisites

| Tool | Use |
|---|---|
| `gcloud` ≥ 470 | GCP control |
| `kubectl` ≥ 1.27 | k8s control |
| `helm` ≥ 3.13 | chart installs |
| `gh` ≥ 2.40 | release lookups |
| `noetl` (rust CLI) | catalog register / register from local YAMLs |

GCP-side prep:

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>
gcloud config set compute/region us-central1
gcloud services enable container.googleapis.com containerregistry.googleapis.com
```

## Step 1 — Create the GKE cluster

For development workloads, a small Autopilot cluster is the
cheapest thing that works (~$70/mo idle, scales to zero on
namespaces without active workloads):

```bash
gcloud container clusters create-auto noetl-mcp \
  --region=us-central1 \
  --release-channel=regular
gcloud container clusters get-credentials noetl-mcp --region=us-central1
kubectl config rename-context "gke_$(gcloud config get-value project)_us-central1_noetl-mcp" gke-noetl-mcp
kubectl config use-context gke-noetl-mcp
kubectl get nodes
```

For Standard (more control over node pools, persistent volumes,
RBAC node-affinity), see [GKE Autopilot Full Provisioning](../../features/gke_autopilot_full_provisioning.md)
for a pre-built playbook.

## Step 2 — Bootstrap postgres + nats

Two paths.

**Cluster-internal Postgres** (cheaper for dev, lives or dies with
the cluster):

```bash
cd repos/noetl
kubectl apply -f ci/manifests/postgres/namespace/namespace.yaml
kubectl create configmap postgres-schema-ddl \
  --namespace postgres \
  --from-file=schema_ddl.sql.norun=noetl/database/ddl/postgres/schema_ddl.sql \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f ci/manifests/postgres/
kubectl rollout status deployment/postgres -n postgres --timeout=300s
```

**Cloud SQL with Private IP via PgBouncer** (recommended for
anything you don't want to lose with `kubectl delete ns`):
follow [GCP Cloud SQL + PgBouncer Private IP](../gcp/cloudsql-pgbouncer-private-ip.md).
The noetl-server's Postgres connection string then points at the
in-cluster pgbouncer service instead of `postgres.postgres.svc...`.

**NATS** is identical to local kind:

```bash
kubectl apply -f ci/manifests/nats/
kubectl rollout status statefulset/nats -n nats --timeout=300s
```

## Step 3 — Apply RBAC + deploy noetl

The same `rbac.yaml` from local kind ships the
`noetl-worker-lifecycle-installer` ClusterRole — it works
unchanged on GKE.

```bash
NOETL_TAG=$(gh release list --repo noetl/noetl --limit 1 --json tagName -q '.[0].tagName')
TARGET_IMAGE="ghcr.io/noetl/noetl:${NOETL_TAG}"

kubectl apply -f ci/manifests/noetl/namespace/
# GKE uses Workload Identity for GCP API access — no key file or
# gcs-credentials secret is needed. The worker deployment does not
# mount GOOGLE_APPLICATION_CREDENTIALS; google.auth.default() picks
# up the GKE metadata-server token automatically.
kubectl apply -f ci/manifests/noetl/rbac.yaml

for manifest in ci/manifests/noetl/*.yaml; do
  if [ -f "$manifest" ]; then
    sed -e "s|image_name:image_tag|${TARGET_IMAGE}|g" "$manifest" | kubectl apply -f -
  fi
done

# imagePullPolicy=Always so GKE pulls from ghcr on each rollout
for d in noetl-server noetl-worker; do
  for c in $(kubectl -n noetl get deployment "$d" -o jsonpath='{.spec.template.spec.containers[*].name}'); do
    kubectl -n noetl patch deployment "$d" --type=strategic -p \
      "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"${c}\",\"imagePullPolicy\":\"Always\"}]}}}}"
  done
done

kubectl -n noetl rollout status deployment/noetl-server --timeout=300s
kubectl -n noetl rollout status deployment/noetl-worker --timeout=300s
```

## Step 4 — Reach the noetl API

GKE clusters typically aren't exposed publicly. Three options:

**Port-forward** (simplest for dev):

```bash
kubectl -n noetl port-forward svc/noetl 8082:8082 > /tmp/noetl-pf.log 2>&1 &
sleep 2
curl -fsS http://localhost:8082/api/health
```

**Ingress + Identity-Aware Proxy (IAP)** (recommended for shared
dev clusters): follow [GKE User Guide](../../iap-gcp/gke_user_guide.md).
The gateway component then sits behind IAP and the GUI uses its
session-token flow as normal.

**Internal LoadBalancer** (cluster reachable from VPC peers):
patch the noetl Service to `type: LoadBalancer` with
`networking.gke.io/load-balancer-type: Internal`. The GUI's
`api_base_url` then points at the internal LB IP.

## Step 5 — Deploy the GUI

Same as local kind — no special handling needed:

```bash
GUI_TAG=$(gh release list --repo noetl/gui --limit 1 --json tagName -q '.[0].tagName')

# Create the namespace + the service yourself; we don't run
# noetl_development_deploy on GKE because that script assumes podman.
kubectl create namespace gui --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install noetl-gui \
  oci://ghcr.io/noetl/charts/noetl-gui \
  --version "$(echo $GUI_TAG | tr -d v)" \
  --namespace gui \
  --set image.repository="ghcr.io/noetl/gui" \
  --set image.tag="${GUI_TAG}" \
  --set image.pullPolicy=Always \
  --set service.type=ClusterIP \
  --set api_base_url="http://noetl.noetl.svc.cluster.local:8082" \
  --set allow_skip_auth=false \
  --set gateway_url="https://gateway.your-domain.com"

kubectl -n gui rollout status deployment/gui --timeout=300s
```

For dev clusters without the gateway, set `allow_skip_auth=true`
and point `api_base_url` at whatever exposes the noetl service to
the GUI's browser (commonly an IAP-protected ingress).

## Step 6 — Register the MCP catalog content

This step is **identical** to local kind — the catalog is
server-side, the noetl CLI just talks to whatever API it's
configured against. Either:

- run `noetl catalog register` from your laptop with `--host`
  pointing at the GKE service's port-forward, or
- run it from a one-off `noetl` CLI pod inside the cluster
  (the noetl image ships the rust binary at `/usr/local/bin/noetl`).

```bash
# Option A — from the laptop with port-forward active
NOETL_HOST=localhost NOETL_PORT=8082 \
  noetl catalog register repos/ops/automation/agents/kubernetes/templates/mcp_kubernetes.yaml
# (and the six lifecycle files; same loop as local kind step 6)
```

### Option B — Register Google Cloud's managed GKE MCP endpoint

Google Cloud also exposes a [managed GKE MCP server](https://docs.cloud.google.com/kubernetes-engine/docs/reference/mcp)
at `https://container.googleapis.com/mcp/read-only`. This option does
not deploy a pod in the `mcp` namespace. It registers a NoETL
`Mcp` resource plus a terminal-visible agent playbook under
`/mcp/gcp`; every terminal call still becomes a normal NoETL
execution recorded in `noetl.event`, `noetl.command`, and the
`noetl.execution` projection.

Register the managed resource and runtime agent:

```bash
cd repos/ops

noetl catalog register automation/agents/gcp/runtime.yaml
noetl catalog register automation/agents/gcp/templates/mcp_gke_managed.yaml
```

The worker that runs the agent needs a Google Cloud access token.
The playbook resolves one in this order:

1. `workload.access_token` passed to the execution (use only for
   local one-off debugging)
2. `GOOGLE_OAUTH_ACCESS_TOKEN` in the worker environment
3. the GKE metadata server for the worker pod's service account

For GKE Workload Identity, bind the NoETL worker Kubernetes
service account to a Google service account with read-only GKE
permissions:

```bash
PROJECT_ID="$(gcloud config get-value project)"
GSA="noetl-worker-mcp@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create noetl-worker-mcp \
  --display-name="NoETL worker managed GKE MCP"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA}" \
  --role="roles/container.viewer"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA}" \
  --role="roles/mcp.toolUser"

gcloud iam service-accounts add-iam-policy-binding "${GSA}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[noetl/noetl-worker]"

kubectl annotate serviceaccount noetl-worker -n noetl \
  "iam.gke.io/gcp-service-account=${GSA}" --overwrite

kubectl rollout restart deployment/noetl-worker -n noetl
```

In the GUI terminal:

```text
cd /mcp
cd /mcp/gcp
status
tools
call list_clusters --set parent=projects/<project-id>/locations/-
```

`roles/container.viewer` grants read-only GKE access. `roles/mcp.toolUser`
grants `mcp.tools.call`, which the managed MCP endpoint requires for
`call <tool>` invocations. If `tools` succeeds but `call list_clusters ...`
returns a 403 for `mcp.googleapis.com/tools.call`, add `roles/mcp.toolUser`
and restart `deployment/noetl-worker`.

Use the managed endpoint for cloud-level GKE inventory and
read-only cluster diagnostics. Use the in-cluster Kubernetes MCP
server below when you want Kubernetes API-server views from inside
the target cluster's network.

## Step 7 — Deploy the in-cluster Kubernetes MCP server via lifecycle.deploy

Same dispatch path as local kind:

```bash
curl -s -X POST http://localhost:8082/api/mcp/mcp/kubernetes/lifecycle/deploy \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
sleep 75
kubectl -n mcp get all
```

GKE's image pull is faster than kind on Apple Silicon (no QEMU);
the entire helm install + pod-pull cycle usually completes in
under 60 seconds.

## Step 8 — Cluster-read RBAC for the MCP server SA

Same manual binding as local kind until the chart values are
fixed:

```bash
cat <<'YAML' | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubernetes-mcp-server-reader
rules:
  - apiGroups: [""]
    resources: ["namespaces", "nodes", "pods", "pods/log", "services", "endpoints", "configmaps", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubernetes-mcp-server-reader
subjects:
  - kind: ServiceAccount
    name: kubernetes-mcp-server
    namespace: mcp
roleRef:
  kind: ClusterRole
  name: kubernetes-mcp-server-reader
  apiGroup: rbac.authorization.k8s.io
YAML
```

## GKE-specific gotchas

### Workload Identity

If your GKE cluster has Workload Identity enabled (the default for
Autopilot), the noetl-worker SA can be bound to a GCP IAM service
account, eliminating the need for in-cluster GCS credentials.
Replace the placeholder secret in step 3 with:

```bash
gcloud iam service-accounts create noetl-worker \
  --display-name="NoETL distributed worker"
gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
  --member="serviceAccount:noetl-worker@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
gcloud iam service-accounts add-iam-policy-binding \
  "noetl-worker@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:$(gcloud config get-value project).svc.id.goog[noetl/noetl-worker]"
kubectl annotate serviceaccount noetl-worker -n noetl \
  "iam.gke.io/gcp-service-account=noetl-worker@$(gcloud config get-value project).iam.gserviceaccount.com"
kubectl rollout restart deployment/noetl-worker -n noetl
```

### Image pull from a private ghcr

If the noetl images are private on ghcr (the default for
non-public-org images), create an imagePullSecret in each
namespace that pulls from ghcr:

```bash
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<your-github-user> \
  --docker-password=<a github token with read:packages> \
  --namespace noetl
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<your-github-user> \
  --docker-password=<token> \
  --namespace gui
```

…and patch the deployments to reference it:

```bash
for ns in noetl gui mcp; do
  kubectl -n "$ns" patch serviceaccount default \
    -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
done
```

### Network policies and the MCP server

If you're running with a default-deny NetworkPolicy, the noetl
worker needs egress to the MCP server's ClusterIP and to the
public internet (helm pulls OCI charts and image registries).
Allow:

- `noetl/noetl-worker → mcp/kubernetes-mcp-server:8080`
- `noetl/noetl-worker → 0.0.0.0/0:443` (for OCI chart + image pulls)

### Persistent storage

Host-path mounts in the kind config don't apply on GKE. Postgres
and noetl data both want StatefulSet PVCs. The default manifests
ship `storageClassName: standard` which Autopilot maps to
`pd-balanced`. For production, override to `premium-rwo` and
size up `pgdata` past 5Gi.

## Verify

Open the GUI (port-forward, IAP-protected ingress, or internal
LoadBalancer URL — whichever you set up in step 4 / 5), navigate
to `mcp/kubernetes`, click `pods`. Real GKE cluster pods should
stream back through the friendly run dialog.

## Related documentation

- [MCP catalog architecture overview](../../architecture/mcp_catalog_architecture.md)
- [MCP End-to-End on Local Kind](./end-to-end-local-kind.md)
- [GKE Autopilot Full Provisioning](../../features/gke_autopilot_full_provisioning.md)
- [GKE User Guide](../../iap-gcp/gke_user_guide.md)
- [GCP Cloud SQL + PgBouncer Private IP](../gcp/cloudsql-pgbouncer-private-ip.md)
