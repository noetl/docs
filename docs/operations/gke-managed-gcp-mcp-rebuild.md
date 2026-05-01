---
title: Managed GKE MCP Rebuild Runbook
description: Re-enable the Google Cloud managed GKE MCP workspace after rebuilding the GKE cluster.
---

# Managed GKE MCP Rebuild Runbook

Use this runbook after destroying and recreating the GKE cluster. It restores
the `/mcp/gcp` terminal workspace so users can inspect GKE through NoETL
playbook executions instead of direct browser-to-cloud calls.

The current production pattern is:

- GUI: Cloudflare Pages at `https://mestumre.dev`
- Gateway: private GKE `ClusterIP` service exposed through Cloudflare Tunnel at
  `https://gateway.mestumre.dev`
- NoETL server and worker: private GKE services
- Managed GKE MCP: Google endpoint
  `https://container.googleapis.com/mcp/read-only`
- NoETL catalog resources:
  - `mcp/gcp/gke` agent playbook
  - `mcp/gcp` MCP workspace resource

## Prerequisites

- GKE cluster exists and `kubectl` points at it.
- NoETL server, worker, gateway, Cloud SQL, NATS, and pgbouncer are deployed.
- The `repos/ops` submodule is on a commit that includes:
  - `automation/agents/gcp/runtime.yaml`
  - `automation/agents/gcp/templates/mcp_gke_managed.yaml`
- Your local shell can run `gcloud`, `kubectl`, and `noetl`.

Set the project and cluster values:

```bash
export PROJECT_ID=noetl-demo-19700101
export REGION=us-central1
export CLUSTER=noetl-cluster
export GSA_NAME=noetl-worker-mcp
export GSA="${GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "${PROJECT_ID}"
gcloud container clusters get-credentials "${CLUSTER}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}"
```

## 1. Restore Cloudflare Edge If Needed

If the cluster was recreated, restore both public edge pieces:

- Cloudflare Pages serves the static GUI at `https://mestumre.dev`.
- Cloudflare Tunnel routes `https://gateway.mestumre.dev` to the private GKE
  Gateway service.

The GKE Gateway service must stay private. Do not expose NoETL server, NoETL
worker, or Gateway directly with a public `LoadBalancer` or `NodePort`.

### 1.1 Token And DNS Inputs

The edge playbook uses Cloudflare API access from your local shell. Export
tokens locally only; never commit them.

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/ops

export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}"
# CLOUDFLARE_API_TOKEN must be exported in the shell but must never be committed.
export CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
```

Use a Cloudflare API token with enough permissions for the action you run:

| Action | Required Cloudflare capability |
|---|---|
| Pages upload | Cloudflare Pages edit on the account |
| Tunnel create/update | Cloudflare Tunnel or Cloudflare One connector edit |
| DNS record create/update | DNS edit on the zone |

If the tunnel already exists and DNS is already configured, the Kubernetes
deployment can use the tunnel token without broad API permissions. If the
playbook creates or updates the tunnel or DNS records, the API token must
include those permissions.

Expected DNS shape:

| Hostname | Cloudflare record | Target |
|---|---|---|
| `mestumre.dev` | Pages custom domain / proxied CNAME | `noetl-gui.pages.dev` |
| `gateway.mestumre.dev` | Tunnel public hostname | `noetl-gke-gateway` |

Remove stale records that point `mestumre.dev` to old GKE ingress or
LoadBalancer IPs. A stale proxied A record can cause Cloudflare `522` after the
GUI has already been moved to Pages.

### 1.2 Deploy Pages, Tunnel, And Private Gateway

Run the Cloudflare edge playbook:

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/ops

noetl run automation/cloudflare/gke_gateway_edge.yaml \
  --runtime local \
  --set action=deploy \
  --set cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID}" \
  --set gateway_service_port=80 \
  --set gateway_hostname=gateway.mestumre.dev \
  --set gui_domain=mestumre.dev \
  --set gateway_public_url=https://gateway.mestumre.dev
```

What this does:

- Builds `repos/gui` with `VITE_API_MODE=gateway`.
- Uploads the GUI bundle to Cloudflare Pages.
- Ensures the GKE Gateway service is `ClusterIP`.
- Creates or updates the Cloudflare tunnel configuration when API permissions
  allow it.
- Deploys or refreshes `cloudflared` in GKE.

For tunnel-only recovery after a cluster rebuild:

```bash
noetl run automation/cloudflare/gke_gateway_edge.yaml \
  --runtime local \
  --set action=tunnel \
  --set cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID}" \
  --set gateway_service_port=80 \
  --set gateway_hostname=gateway.mestumre.dev
```

For GUI-only redeploy after a GUI release:

```bash
noetl run automation/cloudflare/gke_gateway_edge.yaml \
  --runtime local \
  --set action=pages \
  --set cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID}" \
  --set gui_domain=mestumre.dev \
  --set gateway_public_url=https://gateway.mestumre.dev
```

### 1.3 Validate Cloudflare Edge

Validate public endpoints:

```bash
curl -fsS https://gateway.mestumre.dev/health
curl -I https://mestumre.dev
curl -fsSL https://mestumre.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

The NoETL gateway service in GKE should stay private:

```bash
kubectl get svc -A | awk 'NR==1 || $5 != "<none>" {print}'
kubectl -n gateway get svc gateway
```

The gateway service should be `ClusterIP`, not `LoadBalancer` or `NodePort`.

Validate the tunnel pods:

```bash
kubectl -n cloudflare get deploy,pods
kubectl -n cloudflare rollout status deployment/noetl-gke-gateway-tunnel --timeout=180s
```

If `https://gateway.mestumre.dev/health` returns `ok`, the tunnel can reach the
private Gateway service.

If `https://mestumre.dev` returns Cloudflare `522`, the apex domain is probably
still pointing at a stale origin. In Cloudflare DNS, remove old proxied A
records for `mestumre.dev` and attach `mestumre.dev` as a Pages custom domain.

If local `curl https://mestumre.dev` cannot resolve while public resolvers can,
flush local DNS cache or test with a public resolver:

```bash
dig @1.1.1.1 mestumre.dev A +short
dig @1.1.1.1 gateway.mestumre.dev CNAME +short
```

## 2. Configure Workload Identity For The Worker

The NoETL worker calls the managed MCP endpoint. The worker Kubernetes service
account must be bound to a Google service account.

Create the Google service account if it does not exist:

```bash
gcloud iam service-accounts describe "${GSA}" \
  --project "${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam service-accounts create "${GSA_NAME}" \
  --project "${PROJECT_ID}" \
  --display-name="NoETL worker managed GKE MCP"
```

Grant both required roles:

```bash
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA}" \
  --role="roles/container.viewer" \
  --condition=None

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA}" \
  --role="roles/mcp.toolUser" \
  --condition=None
```

Why both roles are required:

- `roles/container.viewer` grants read-only GKE permissions such as
  `container.clusters.list`.
- `roles/mcp.toolUser` grants `mcp.tools.call`, which is required by Google's
  managed MCP endpoint for `tools/call`. Without it, `tools` can succeed while
  `call list_clusters ...` fails with:

```text
Permission 'mcp.googleapis.com/tools.call' denied on resource
```

Bind the Kubernetes service account to the Google service account:

```bash
gcloud iam service-accounts add-iam-policy-binding "${GSA}" \
  --project "${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[noetl/noetl-worker]"

kubectl annotate serviceaccount noetl-worker -n noetl \
  "iam.gke.io/gcp-service-account=${GSA}" \
  --overwrite
```

Restart the worker so fresh metadata tokens pick up the new IAM roles:

```bash
kubectl -n noetl rollout restart deployment/noetl-worker
kubectl -n noetl rollout status deployment/noetl-worker --timeout=180s
```

Validate the binding:

```bash
kubectl -n noetl get serviceaccount noetl-worker \
  -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}{"\n"}'

gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${GSA} AND bindings.role:(roles/container.viewer OR roles/mcp.toolUser)" \
  --format='table(bindings.role,bindings.members)'
```

## 3. Register MCP Catalog Content

Register the agent playbook first, then the MCP workspace resource.

Use a port-forward if you are registering directly against the private NoETL
server:

```bash
kubectl -n noetl port-forward svc/noetl 18082:8082
```

In another shell:

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/ops

noetl --host localhost --port 18082 catalog register \
  automation/agents/gcp/runtime.yaml

noetl --host localhost --port 18082 catalog register \
  automation/agents/gcp/templates/mcp_gke_managed.yaml
```

Expected catalog entries:

| Path | Kind | Purpose |
|---|---|---|
| `mcp/gcp/gke` | `playbook` | Terminal-visible agent that calls Google's managed MCP endpoint. |
| `mcp/gcp` | `mcp` | Workspace resource discovered by the GUI terminal. |

If you register through the public Gateway instead, make sure the session has
permission to register catalog resources.

## 4. Deploy The GUI If Needed

Deploy Cloudflare Pages after GUI changes that affect the terminal, such as:

- MCP workspace discovery
- terminal table rendering
- footer Terminal/Dashboard behavior

Use the same edge playbook:

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/ops

noetl run automation/cloudflare/gke_gateway_edge.yaml \
  --runtime local \
  --set action=deploy \
  --set cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID}" \
  --set gateway_service_port=80 \
  --set gateway_hostname=gateway.mestumre.dev \
  --set gui_domain=mestumre.dev \
  --set gateway_public_url=https://gateway.mestumre.dev
```

Confirm `mestumre.dev` serves the new bundle:

```bash
curl -fsSL https://mestumre.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

## 5. Validate From The GUI Terminal

Open `https://mestumre.dev`, then run:

```text
cd /mcp
ls
cd /mcp/gcp
status
tools
```

`tools` should show a table with entries like:

```text
gcp tools :: 15
check=1 describe=1 get=8 list=5
NAME                    KIND  DESCRIPTION
list_k8s_api_resources  tool  -
check_k8s_auth          tool  -
list_clusters           tool  -
get_cluster             tool  -
```

Generic MCP tool invocation requires the `call` prefix:

```text
call list_clusters --set parent=projects/noetl-demo-19700101/locations/-
```

JSON arguments also work:

```text
call list_clusters {"parent":"projects/noetl-demo-19700101/locations/-"}
```

Useful follow-up calls:

```text
call get_cluster --set name=projects/noetl-demo-19700101/locations/us-central1/clusters/noetl-cluster
call list_node_pools --set parent=projects/noetl-demo-19700101/locations/us-central1/clusters/noetl-cluster
call get_k8s_cluster_info
call get_k8s_version
call list_k8s_api_resources
```

Every command should start a NoETL execution and return a clickable `open` or
`report` action. This is intentional: MCP activity is auditable through the
normal NoETL execution/event tables.

## 6. Validate Without The GUI

This direct API smoke uses the current catalog id for `mcp/gcp/gke`.

```bash
CATALOG_ID="$(curl -fsS -X POST http://localhost:18082/api/catalog/agents/list \
  -H 'Content-Type: application/json' \
  -d '{}' | jq -r '.entries[]
    | select(.path=="mcp/gcp/gke")
    | select((.payload.metadata.terminal.visible // true) != false)
    | .catalog_id' | head -1)"

curl -fsS -X POST http://localhost:18082/api/execute \
  -H 'Content-Type: application/json' \
  -d "{
    \"catalog_id\":\"${CATALOG_ID}\",
    \"resource_kind\":\"playbook\",
    \"workload\":{
      \"method\":\"tools/call\",
      \"tool\":\"list_clusters\",
      \"arguments\":{\"parent\":\"projects/${PROJECT_ID}/locations/-\"},
      \"timeout_seconds\":60
    }
  }"
```

Then inspect the execution:

```bash
curl -fsS "http://localhost:18082/api/executions/<execution_id>/events" \
  | jq '.events[]
    | select(.event_type=="command.completed" or .event_type=="command.failed" or .event_type=="call.error")
    | {event_type,node_id,status,result:.result}'
```

Success includes `status: ok`, `method: tools/call`, `tool: list_clusters`,
and cluster data containing `noetl-cluster`.

## Troubleshooting

### `list_clusters` says unknown command

Use the generic MCP command form:

```text
call list_clusters --set parent=projects/<project-id>/locations/-
```

Direct tool-name aliases are not enabled for generic MCP workspaces yet.

### `tools` works, but `call ...` returns HTTP 403

Look for this error:

```text
Permission 'mcp.googleapis.com/tools.call' denied on resource
```

Fix:

```bash
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA}" \
  --role="roles/mcp.toolUser" \
  --condition=None

kubectl -n noetl rollout restart deployment/noetl-worker
kubectl -n noetl rollout status deployment/noetl-worker --timeout=180s
```

### `tools` shows `tools=0`

Common causes:

- The GUI is old and does not parse compact MCP tool output.
- The terminal executed an old `mcp/gcp/gke` catalog version.
- The agent playbook result was externalized because the output was too large.

Fix:

1. Deploy the current GUI to Cloudflare Pages.
2. Register the current `automation/agents/gcp/runtime.yaml`.
3. Ensure only the latest `mcp/gcp/gke` agent version is terminal-visible, or
   use a GUI release that chooses the highest visible agent version.

Inspect visible versions:

```bash
curl -fsS -X POST http://localhost:18082/api/catalog/agents/list \
  -H 'Content-Type: application/json' \
  -d '{}' \
  | jq '.entries[]
    | select(.path=="mcp/gcp/gke")
    | {catalog_id,version,visible:.payload.metadata.terminal.visible}'
```

### Worker has correct roles but calls still fail

IAM changes can be hidden by cached metadata tokens. Restart the worker:

```bash
kubectl -n noetl rollout restart deployment/noetl-worker
kubectl -n noetl rollout status deployment/noetl-worker --timeout=180s
```

### Gateway or GUI is unreachable

Check Cloudflare Tunnel and the private Gateway service:

```bash
kubectl -n cloudflare get deploy,pods
kubectl -n gateway get svc gateway
curl -fsS https://gateway.mestumre.dev/health
curl -I https://mestumre.dev
```

The Gateway service should remain private (`ClusterIP`). The public path should
be Cloudflare Pages for the GUI and Cloudflare Tunnel for Gateway.
