---
title: 'GKE production deploy'
sidebar_label: '02 · GKE Production Deploy'
sidebar_position: 2
description: 'Provision a GKE cluster, deploy the NoETL stack with Vertex AI as the triage backend, configure Auth0 + ingress + TLS, and run the spike against the cloud cluster. About 1–2 hours.'
---

# GKE production deploy

> **Status:** stub. The full walkthrough is queued for a subsequent
> tutorial round. The structure below names every step plus the
> existing reference doc that covers it; the next round fills in the
> commands, expected outputs, and gotchas.

This tutorial deploys the NoETL stack to a Google Kubernetes Engine
cluster using the canonical
[`noetl_gke_fresh_stack`](https://github.com/noetl/ops/blob/main/automation/gcp_gke/noetl_gke_fresh_stack.yaml)
playbook, wires Vertex AI as the triage backend through Workload
Identity, configures Auth0 + ingress + managed TLS, and validates by
running the spike e2e against the deployed cluster.

Estimated time: 1–2 hours including provisioning.

## Prerequisites

{/* TODO: enumerate concretely */}
- Completed [Quickstart](./01-quickstart.md) so you understand the
  local-cluster baseline.
- A GCP project with billing enabled and the following APIs on:
  `container.googleapis.com`, `aiplatform.googleapis.com`,
  `secretmanager.googleapis.com`, `artifactregistry.googleapis.com`.
- `gcloud` authenticated (`gcloud auth login` + `gcloud config set project <id>`).
- An Auth0 tenant with at least one Single Page Application client
  configured. See [Auth Integration](../gateway/auth-integration.md)
  for the gateway-side contract.
- A domain you can point at the GKE Ingress (Auth0 callback URLs need
  to resolve).

## Step 1 — Provision the cluster

{/* TODO:
  - Run noetl_gke_fresh_stack with action=provision-deploy
  - Pick autopilot vs standard based on workload sizing
  - The blueprint at automation/gcp_gke/blueprints/noetl-cluster-blueprint.json
    is the source of truth for cluster shape
  - Cite operations/gcp/gke-cloudsql-end-to-end.md for the long-form variant
  - Walk the actual command + expected output
*/}

Reference: [`automation/gcp_gke/noetl_gke_fresh_stack.yaml`](https://github.com/noetl/ops/blob/main/automation/gcp_gke/noetl_gke_fresh_stack.yaml).

## Step 2 — Wire Workload Identity for Vertex AI

{/* TODO:
  - Create GCP service account, bind roles/aiplatform.user
  - Create k8s service account, annotate with Workload Identity binding
  - Patch noetl-worker deployment to use the bound k8s SA
  - Confirm: kubectl exec into worker, curl metadata server, validate
    cloud-platform scope token can be retrieved
  - Cite architecture/vertex_ai_triage_backend.md for the credential
    surface design
*/}

The token flow goes through the GKE metadata server with the
`https://www.googleapis.com/auth/cloud-platform` scope. See
[Vertex AI Triage Backend → Credential surface](../architecture/vertex_ai_triage_backend.md)
for why this is preferred over service-account JSON files in pods.

## Step 3 — Configure Auth0 callbacks

{/* TODO:
  - Add callback URLs: https://<your-gateway-host>/callback,
    https://<your-gateway-host>/api/auth/callback
  - Add allowed origins
  - Capture domain + client_id + client_secret to Secret Manager
  - Wire gateway deployment to read those secrets via External Secrets
    Operator or CSI Secret Store driver
  - Cite gateway/auth-integration.md and gateway/auth0-setup.md
*/}

## Step 4 — Deploy via `bump_image` lifecycle

{/* TODO:
  - Use noetl exec automation/agents/noetl/lifecycle/bump_image
    payloads for noetl-server, noetl-worker, ollama-bridge OR skip
    ollama-bridge if you're going pure-Vertex with no in-cluster
    Ollama.
  - The GHCR availability probe from ops#37 catches release races
    automatically — see operations/bump_image.md
  - Wait for kubectl rollout status on each
*/}

Reference: [Bump Image Lifecycle](../operations/bump_image.md).

## Step 5 — Register catalog playbooks on the GKE noetl-server

{/* TODO:
  - From your workstation, point noetl --server at the GKE URL
  - noetl --server https://gateway.your-domain/api/noetl catalog register ...
  - Required playbooks: tests/spike/spike_e2e_test, the diagnose agent,
    bump_image (for in-cluster lifecycle), mcp/vertex-ai
  - Mention catalog versions on GKE will differ from local — that's
    expected
*/}

## Step 6 — Run the spike with Vertex backend

{/* TODO:
  - noetl --server <gke-url> exec tests/spike/spike_e2e_test
    --payload '{"escalate_to":"none","triage_mcp_server":"mcp/vertex-ai","triage_model":"gemini-2.5-flash"}'
  - Capture exec_id, wait for terminal
  - Confirm source=vertex-ai in the diagnosis
  - Walk the _meta.diagnosis_fetch telemetry — should show 1-3 polls
    typical with elapsed_seconds in the 1-3 second range for warm
    Vertex calls
*/}

## Step 7 — Validate Workload Identity is in the loop

{/* TODO:
  - Inspect the diagnose sub-execution events
  - Find the events where the Vertex GenerateContent call was made
  - Confirm no service-account-JSON references in the call shape
  - Confirm token usage telemetry is captured in
    error.diagnosis._meta.usage
*/}

## Next steps

{/* TODO */}
- [Frontend onboarding](./04-frontend-onboarding.md) — point a real
  frontend at the deployed gateway.
- [Add a new MCP backend](./05-add-new-mcp-backend.md) — once Vertex
  is comfortable, add a second cloud backend behind the same contract.

## Troubleshooting

{/* TODO: top 5 GKE-specific gotchas
  - aiplatform.googleapis.com not enabled
  - Workload Identity binding missing or scoped to wrong namespace
  - Auth0 callback URL mismatch
  - GHCR rate limit during fresh deploy (operations/bump_image.md
    troubleshooting section)
  - Model availability — if gemini-2.5-flash returns 404, see the model
    availability section in vertex_ai_triage_backend.md
*/}
