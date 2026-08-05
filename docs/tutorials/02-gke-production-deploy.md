---
title: 'GKE production deploy'
sidebar_label: '02 · GKE Production Deploy'
sidebar_position: 2
description: 'Provision a GKE cluster, deploy the NoETL stack with Vertex AI as the triage backend, configure Auth0 + ingress + TLS, and run the spike against the cloud cluster. About 1–2 hours.'
---

# GKE production deploy

This tutorial deploys the NoETL stack to Google Kubernetes Engine using
the canonical `noetl_gke_fresh_stack` playbook, wires Vertex AI as the
triage backend through Workload Identity, configures Auth0 + ingress +
managed TLS, and validates by running the spike e2e against the
deployed cluster with `_meta.diagnosis_fetch` telemetry visible in
persisted events.

Estimated time: 1–2 hours including cluster provisioning. If the
cluster already exists, the deploy + validation portion is ~30 minutes.

## Prerequisites

- Completed [Quickstart](./01-quickstart.md) so you understand the
  local-cluster baseline and the architectural surface NoETL exercises.
- A GCP project with billing enabled. The tutorial uses placeholder
  `<project-id>` — substitute yours throughout.
- The following GCP APIs enabled (operator decision; bills against your
  project):
  - `container.googleapis.com` (GKE)
  - `aiplatform.googleapis.com` (Vertex AI)
  - `secretmanager.googleapis.com` (gateway secrets)
  - `artifactregistry.googleapis.com` (image mirror, optional but
    recommended)
- `gcloud` authenticated: `gcloud auth login` then
  `gcloud config set project <project-id>`.
- An Auth0 tenant with at least one Single Page Application client
  configured. See [Auth Integration](../gateway/auth-integration.md) for
  the gateway-side contract; this tutorial assumes that page's setup is
  complete.
- A domain you can point at the GKE Ingress (Auth0 callback URLs need
  to resolve before login works).

## Step 1 — Provision the cluster

The canonical provisioning playbook is
[`automation/gcp_gke/noetl_gke_fresh_stack`](https://github.com/noetl/ops/blob/main/automation/gcp_gke/noetl_gke_fresh_stack.yaml).
It supports `provision`, `deploy`, `provision-deploy`, `status`, and
`destroy` actions through a single workload knob. For a fresh cluster
plus full stack deploy in one shot:

```bash
noetl run automation/gcp_gke/noetl-gke-fresh-stack \
  --runtime local \
  --payload '{
    "action": "provision-deploy",
    "project_id": "<project-id>",
    "region": "us-central1",
    "cluster_name": "noetl-cluster",
    "release_channel": "regular",
    "create_artifact_registry": true,
    "repository_id": "noetl",
    "build_images": false,
    "noetl_image": "ghcr.io/noetl/noetl:v2.37.2",
    "gateway_image": "ghcr.io/noetl/gateway:v2.10.0",
    "gui_image": "ghcr.io/noetl/gui:v1.8.0"
  }'
```

The blueprint at
[`automation/gcp_gke/blueprints/noetl-cluster-blueprint.json`](https://github.com/noetl/ops/blob/main/automation/gcp_gke/blueprints/noetl-cluster-blueprint.json)
is the source of truth for cluster shape — Autopilot enabled by
default, COS_CONTAINERD nodes, Filestore + GCS Fuse CSI drivers
configured, network policy disabled (use VPC-native controls instead).

For an existing cluster (e.g. you already have `noetl-cluster` in
`us-central1`), run with `action: "deploy"` to skip provisioning.

Fetch credentials and confirm the cluster is reachable:

```bash
gcloud container clusters get-credentials noetl-cluster \
  --region=us-central1 \
  --project=<project-id>
kubectl get nodes
```

For the long-form variant including Cloud SQL and IAP ingress, see
[GKE + Cloud SQL end-to-end](../operations/gcp/gke-cloudsql-end-to-end.md).

## Step 2 — Wire Workload Identity for Vertex AI

The Vertex AI triage backend authenticates via the GKE metadata server
with a `cloud-platform`-scoped token. No service-account JSON needs to
land in any pod — the cluster's Workload Identity binding handles it.
See [Vertex AI Triage Backend → Credential surface](../architecture/vertex_ai_triage_backend.md)
for why this is the canonical pattern.

Create the GCP service account, grant Vertex access, bind it to the
Kubernetes service account that `noetl-worker` runs as:

```bash
GCP_SA="noetl-vertex-sa@<project-id>.iam.gserviceaccount.com"
K8S_SA_NAMESPACE="noetl"
K8S_SA_NAME="noetl-worker"

# 1. Create the GCP service account
gcloud iam service-accounts create noetl-vertex-sa \
  --display-name="NoETL Vertex AI runtime SA" \
  --project=<project-id>

# 2. Grant Vertex AI user role
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:${GCP_SA}" \
  --role="roles/aiplatform.user"

# 3. Bind the GKE SA to the GCP SA via Workload Identity
gcloud iam service-accounts add-iam-policy-binding ${GCP_SA} \
  --role=roles/iam.workloadIdentityUser \
  --member="serviceAccount:<project-id>.svc.id.goog[${K8S_SA_NAMESPACE}/${K8S_SA_NAME}]" \
  --project=<project-id>

# 4. Annotate the Kubernetes service account
kubectl -n ${K8S_SA_NAMESPACE} annotate serviceaccount ${K8S_SA_NAME} \
  iam.gke.io/gcp-service-account=${GCP_SA} \
  --overwrite
```

Confirm a worker pod can fetch a token from the metadata server:

```bash
kubectl -n noetl run deploy/noetl-worker -- \
  curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | jq -r '.token_type'
# Expect: "Bearer"
```

If the binding is missing or scoped wrong, the worker logs Vertex calls
returning 401 even though the Vertex API is enabled — the metadata
server returns a token but it lacks the requested scope.

## Step 3 — Configure Auth0 callbacks

The gateway exchanges the Auth0 `id_token` for a NoETL session via
`POST /api/auth/login`. Auth0's callback URL needs to match the
gateway's domain before any of that works.

In the Auth0 dashboard for your SPA client:

- **Allowed Callback URLs**: `https://<your-gateway-host>/callback`,
  `https://<your-gateway-host>/api/auth/callback`
- **Allowed Web Origins**: `https://<your-gateway-host>`
- **Allowed Logout URLs**: `https://<your-gateway-host>` (and any
  logout-redirect destinations your frontend uses)

Capture the Auth0 domain + client_id + client_secret to GCP Secret
Manager so the gateway deployment can read them via External Secrets
Operator or the GCP CSI Secret Store driver:

```bash
echo -n "your-tenant.us.auth0.com" | gcloud secrets create auth0-domain \
  --data-file=- --project=<project-id>
echo -n "<client-id>" | gcloud secrets create auth0-client-id \
  --data-file=- --project=<project-id>
echo -n "<client-secret>" | gcloud secrets create auth0-client-secret \
  --data-file=- --project=<project-id>
```

The gateway's `templates/secrets.yaml` (in
`automation/gcp_gke/assets/gateway/`) maps these into the gateway pod's
environment. See [Auth0 Setup](../gateway/auth0-setup.md) for the
complete tenant-side configuration including custom claims and
permission scoping.

## Step 4 — Deploy via `bump_image` lifecycle

The `noetl_gke_fresh_stack` playbook in step 1 already deployed the
initial images. For subsequent version bumps, use the
[`bump_image`](../operations/bump_image.md) lifecycle agent — it gets
you the GHCR availability probe (so a release race fails fast instead
of timing out the kubectl rollout) and the idempotent unchanged path
for verification.

```bash
# Bump noetl-server
noetl run noetl/lifecycle/bump_image \
  --runtime distributed \
  --payload '{
    "deployment": "noetl-server",
    "namespace": "noetl",
    "image": "ghcr.io/noetl/noetl:v2.37.2"
  }'

# Bump noetl-worker
noetl run noetl/lifecycle/bump_image \
  --runtime distributed \
  --payload '{
    "deployment": "noetl-worker",
    "namespace": "noetl",
    "image": "ghcr.io/noetl/noetl:v2.37.2"
  }'

# Wait for rollouts
kubectl -n noetl rollout status deploy/noetl-server --timeout=300s
kubectl -n noetl rollout status deploy/noetl-worker --timeout=300s
```

`bump_image` skips ollama-bridge if you're going pure-Vertex (no
in-cluster Ollama). The deployment selector is name-based; if the
deployment doesn't exist, the playbook reports `skipped` for that
component cleanly.

## Step 5 — Register catalog playbooks on the GKE noetl-server

Point your local `noetl` CLI at the GKE noetl-server URL and register
the playbooks the cluster needs. The default catalog defaults stay
local-Ollama-friendly; GKE operators pass `triage_*` overrides per
payload (see "How the choice flows" in
[Triage Model Selection](../architecture/triage_model_selection.md)).

```bash
GKE_NOETL_URL="https://gateway.<your-domain>/api/noetl"

noetl --server $GKE_NOETL_URL catalog register \
  repos/e2e/fixtures/playbooks/spike/spike_e2e_test.yaml

noetl --server $GKE_NOETL_URL catalog register \
  repos/ops/automation/agents/troubleshoot/diagnose_execution.yaml

noetl --server $GKE_NOETL_URL catalog register \
  repos/ops/automation/agents/mcp/vertex-ai.yaml

noetl --server $GKE_NOETL_URL catalog register \
  repos/ops/automation/agents/noetl/lifecycle/bump_image.yaml
```

Catalog versions on GKE will differ from your local catalog —
that's expected. Each environment maintains its own catalog backing
store and version sequence.

## Step 6 — Run the spike with Vertex backend

Validate Workload Identity, the catalog wiring, and the full
diagnostic path in one shot:

```bash
EXEC_ID=$(noetl --server $GKE_NOETL_URL exec \
  tests/spike/spike_e2e_test \
  --runtime distributed \
  --payload '{
    "escalate_to": "none",
    "triage_mcp_server": "mcp/vertex-ai",
    "triage_model": "gemini-2.5-flash"
  }' \
  --json | jq -r '.execution_id')

# Wait for terminal — typically 5–15 seconds with a warm Vertex backend.
sleep 30
noetl --server $GKE_NOETL_URL status "$EXEC_ID" --json > /tmp/gke_spike.json

python3 scripts/spike_e2e_assert.py /tmp/gke_spike.json
```

You should see `All checks passed. NoETL-as-AI-OS spike e2e smoke is
GREEN.` followed by `diagnosis source: vertex-ai` and
`diagnosis category: ...`.

## Step 7 — Validate Workload Identity is in the loop

Inspect the diagnose sub-execution to confirm the call actually went
through Vertex AI (not a fallback or a stub) and that telemetry was
captured:

```bash
python3 - <<'PY'
import json
with open('/tmp/gke_spike.json') as f:
    doc = json.load(f)

for evt in doc.get('events', []):
    diag = (
        evt.get('result', {})
           .get('context', {})
           .get('error', {})
           .get('diagnosis')
    )
    if not isinstance(diag, dict):
        continue
    meta = diag.get('_meta', {})
    fetch = meta.get('diagnosis_fetch', {})
    usage = meta.get('usage', {})
    print(f"event {evt.get('event_id')} ({evt.get('node_name')}):")
    print(f"  source = {diag.get('source')}")
    print(f"  model  = {diag.get('model')}")
    print(f"  poll_count       = {fetch.get('poll_count')}")
    print(f"  elapsed_seconds  = {fetch.get('elapsed_seconds')}")
    print(f"  prompt_tokens    = {usage.get('prompt_tokens')}")
    print(f"  completion_tokens= {usage.get('completion_tokens')}")
    break
PY
```

Expected output (warm Vertex):

```text
event 62... (trigger_failure):
  source = vertex-ai
  model  = gemini-2.5-flash
  poll_count       = 1
  elapsed_seconds  = 0.064
  prompt_tokens    = 42
  completion_tokens= 35
```

A few things to confirm:

- `source = vertex-ai` (NOT `vertex-stub`, NOT `ollama`). Confirms
  the real backend is in the loop.
- `model = gemini-2.5-flash` — if this comes back as something else,
  your catalog default has drifted from your payload override.
- `poll_count` and `elapsed_seconds` populated. The new
  `_meta.diagnosis_fetch` telemetry from v2.37.0+ — see
  [Vertex AI Triage Backend → Cloud latency](../architecture/vertex_ai_triage_backend.md)
  for what cold vs warm numbers should look like.
- `prompt_tokens` and `completion_tokens` populated. Confirms cost
  telemetry is plumbed end-to-end; operators read these in production
  to monitor per-execution cost.

If telemetry is missing, the worker's projection layer is stripping
it — see [Agent Failure Diagnostics → projection contract](../architecture/agent_failure_diagnostics.md)
and verify your noetl version is at v2.37.1 or later.

If prompt widgets are missing from GUI reports, verify noetl v2.37.2
or later is deployed. That release preserves `render.args` through the
same worker projection chokepoint used by diagnosis telemetry, and GUI
v1.8.0 renders the descriptor inside the terminal-style prompt.

## Next steps

- [Frontend developer onboarding](./04-frontend-onboarding.md) — point a
  real frontend at the deployed gateway with Auth0 login.
- [Add a new MCP backend](./05-add-new-mcp-backend.md) — once Vertex
  is comfortable, add a second cloud backend behind the same JSON-RPC
  contract.

## Troubleshooting

**`aiplatform.googleapis.com` not enabled.** The first Vertex call
returns a clean 403 with a link to enable. Run
`gcloud services enable aiplatform.googleapis.com --project=<project-id>`
and retry. Operator-driven (billing implications) — automation should
not enable APIs autonomously.

**Workload Identity binding missing or scoped to wrong namespace.**
Vertex calls return 401 from the worker even though the API is
enabled. Re-check the four-step binding in step 2: GCP SA exists,
`roles/aiplatform.user` granted, `roles/iam.workloadIdentityUser`
grants the K8s SA the right to impersonate, and the K8s SA has the
`iam.gke.io/gcp-service-account` annotation. The metadata-server
token-fetch test at the end of step 2 catches all four.

**Auth0 callback URL mismatch.** Login redirects to Auth0, you
authenticate, then Auth0 returns an error like "callback URL not
allowed." Re-check the Allowed Callback URLs include both
`/callback` and `/api/auth/callback` for your gateway domain. Auth0's
callback comparison is exact-match including trailing slash; copy
carefully.

**GHCR rate limit during fresh deploy.** GHCR rate-limits anonymous
pulls to ~60/hour per IP. The `bump_image` GHCR probe surfaces this
fast with a clean error rather than a hung kubectl rollout. Workaround:
mirror the noetl images to Artifact Registry once at deploy time, then
point pods at the AR copy. The `noetl_gke_fresh_stack` playbook's
`create_artifact_registry: true` knob does this automatically when
provisioning.

**Vertex returns 404 for `gemini-2.5-flash`.** Some Vertex models
require per-project Model Garden activation. See
[Vertex AI Triage Backend → Model availability](../architecture/vertex_ai_triage_backend.md)
for the diagnosis flow. Workaround: pick a model that IS available in
your project (`gcloud ai models list --region=us-central1
--project=<project-id>` enumerates them) and override `triage_model`
accordingly.

**Spike completes but `diagnosis source` reads `ollama` instead of
`vertex-ai`.** Your payload override didn't take. Most often this is
because the catalog default is still `mcp/ollama` and your workload
forgot to pass the override. Re-read the spike payload — both
`triage_mcp_server: "mcp/vertex-ai"` AND `triage_model:
"gemini-2.5-flash"` need to be present for the swap to work end-to-end.

**`noetl --server` connection refused.** Your local CLI can't reach
the GKE noetl-server URL. Most often the gateway URL is right but the
`/api/noetl` path is wrong, or your DNS hasn't propagated yet. Try
`curl https://gateway.<your-domain>/api/health` first to confirm the
gateway itself is reachable, then debug the noetl-server path.
