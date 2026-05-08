---
title: 'Quickstart: from clone to a green spike e2e'
sidebar_label: '01 · Quickstart'
sidebar_position: 1
description: 'Bootstrap a local NoETL cluster, run the spike e2e, and read the diagnostic telemetry — about 15 minutes.'
---

# Quickstart: from clone to a green spike e2e

This tutorial gets a complete NoETL stack running on your laptop and walks
you through one full self-troubleshooting playbook execution. By the end
you will have:

- A Podman-backed kind cluster with NoETL server, worker, gateway, GUI, Postgres, NATS, and Ollama all running.
- The `gemma3:4b` model loaded for the auto-troubleshoot triage path.
- One spike e2e execution that reaches GREEN with structured diagnostic telemetry visible in persisted events.
- All six prepared regression smokes passing.

Estimated time: 15–20 minutes if dependencies are already installed.

## Prerequisites

- macOS or Linux. Windows works through WSL2 but is not the primary path.
- [Podman](https://podman.io) 5.x. **Do not use Docker Desktop or Colima** for the canonical local path — see [Local Podman Kind Cluster](../operations/local-cluster.md) for the rationale.
- [kind](https://kind.sigs.k8s.io) v0.20+.
- `kubectl` 1.28+.
- Python 3.10+ for the smoke scripts.
- The NoETL CLI — install via `brew tap noetl/tap && brew install noetl` or follow [Quick Start](../getting-started/quickstart.md).
- About 16 GiB of memory for the Podman VM.

## Step 1 — Bootstrap the local cluster

The local automation assumes a Podman VM with `/Volumes` mounted and a clean
`XDG_DATA_HOME` setting. The full rationale is in
[Local Podman Kind Cluster](../operations/local-cluster.md); the short version:

```bash
# Initialize a Podman machine sized for the full NoETL stack.
podman machine init \
  --memory=16384 \
  --cpus=4 \
  --disk-size=200 \
  --volume=/Volumes:/Volumes \
  noetl-dev

podman machine start noetl-dev

# Confirm the machine is healthy and the volume mount took.
podman machine list
podman machine ssh noetl-dev -- ls /Volumes
```

If your shell exports `XDG_DATA_HOME` to a custom location, unset it before
running Podman/kind commands. Mixed locations split machine state and
break `podman machine list`.

```bash
unset XDG_DATA_HOME
```

Now create the kind cluster:

```bash
kind create cluster --name=noetl-cluster
kubectl cluster-info --context=kind-noetl-cluster
```

`kubectl get nodes` should show one Ready node within ~30 seconds.

## Step 2 — Deploy the NoETL stack

NoETL deploys go through the `bump_image` lifecycle agent rather than raw
`kubectl apply`. This gives you the GHCR availability probe (so a release
race fails fast instead of timing out a kubectl rollout) and the idempotent
unchanged path for free. See [Bump Image Lifecycle](../operations/bump_image.md)
for the full operational contract.

For a fresh local cluster, the simplest path is the development bootstrap
playbook from `repos/ops`:

```bash
# From the ai-meta workspace root.
noetl exec automation/development/noetl --runtime local --payload '{
  "namespace": "noetl",
  "noetl_image": "ghcr.io/noetl/noetl:v2.37.2",
  "gateway_image": "ghcr.io/noetl/gateway:v2.10.0",
  "gui_image": "ghcr.io/noetl/gui:v1.8.0"
}'
```

Wait until rollouts converge — 1–3 minutes on a warm host:

```bash
kubectl -n noetl rollout status deploy/noetl-server --timeout=180s
kubectl -n noetl rollout status deploy/noetl-worker --timeout=180s
kubectl -n noetl rollout status deploy/ollama-bridge --timeout=180s
kubectl -n noetl rollout status deploy/gateway --timeout=180s
kubectl -n noetl rollout status deploy/gui --timeout=180s
```

Quick health check:

```bash
kubectl -n noetl get pods
curl -sf http://localhost:8082/api/health
```

`/api/health` should return `{"status":"ok"}` once the noetl-server pod is
Ready.

## Step 3 — Pull the triage model

The auto-troubleshoot path uses Ollama-hosted `gemma3:4b` as the default
triage model. See [Triage Model Selection](../architecture/triage_model_selection.md)
for the rationale and tier comparison.

```bash
kubectl -n noetl exec deploy/ollama -- ollama pull gemma3:4b
kubectl -n noetl exec deploy/ollama -- ollama list
```

`ollama list` should show `gemma3:4b` at roughly 3.0 GB.

## Step 4 — Run the spike

The spike e2e (`tests/spike/spike_e2e_test`, lives in
[`repos/e2e/fixtures/playbooks/spike/spike_e2e_test.yaml`](https://github.com/noetl/e2e/blob/main/fixtures/playbooks/spike/spike_e2e_test.yaml))
deliberately invokes a failing sub-playbook so the auto-troubleshoot path
exercises end-to-end:

```bash
EXEC_ID=$(noetl exec tests/spike/spike_e2e_test \
  --runtime distributed \
  --payload '{"escalate_to":"none"}' \
  --json | jq -r '.execution_id')
echo "execution: $EXEC_ID"

# Wait for terminal status — typically 8–15 seconds on local kind.
sleep 30
noetl status "$EXEC_ID" --json > /tmp/spike.json
```

`noetl status` is the canonical way to fetch execution state. It hits the
same `/api/executions/<id>` endpoint the gateway exposes but goes through
the CLI's host/port resolution and credential plumbing — keeps your scripts
portable across local kind, GKE, and any future deployment topology
without hardcoded URLs.

Run the assertion script to confirm GREEN:

```bash
python3 scripts/spike_e2e_assert.py /tmp/spike.json
```

You should see `All checks passed. NoETL-as-AI-OS spike e2e smoke is GREEN.`
followed by `diagnosis source: ollama` and `diagnosis category: ...`.

## Step 5 — Read the telemetry

The spike's `extract_envelope` step pulls a useful summary into the parent
result, but the canonical diagnostic data lives deeper in the persisted
event stream at `events[N].result.context.error.diagnosis._meta.diagnosis_fetch`:

```bash
python3 - <<'PY'
import json
with open('/tmp/spike.json') as f:
    doc = json.load(f)

for evt in doc.get('events', []):
    diag_fetch = (
        evt.get('result', {})
           .get('context', {})
           .get('error', {})
           .get('diagnosis', {})
           .get('_meta', {})
           .get('diagnosis_fetch')
    )
    if diag_fetch:
        print(f"event {evt.get('event_id')} ({evt.get('node_name')}):")
        for k, v in diag_fetch.items():
            print(f"  {k} = {v}")
        break
PY
```

Expected output:

```text
event 62123... (trigger_failure):
  poll_count = 1
  elapsed_seconds = 0.064
  deadline_seconds = 60.0
  hit_deadline = False
```

That `poll_count = 1, elapsed_seconds ≈ 0.06` is the warm-path signature.
The diagnose sub-execution finished and its result was persisted before
the noetl-side fetch loop reached its first sleep. See
[Vertex AI Triage Backend](../architecture/vertex_ai_triage_backend.md) for
the full cloud-vs-local profile and what cold-start numbers look like.

GUI v1.8.0 also renders step results that include `render: { type, args }`
inside the terminal-style prompt. See
[Widgets in output](../gui/widgets.md) for the contract and
[Catalog UX](../gui/catalog-ux.md) for the kind-aware catalog surface
that pairs with those prompt outputs.

## Step 6 — Run the regression smokes

NoETL ships six prepared smoke regression detectors. Run them all to
confirm the architectural surface is clean:

```bash
cd /Volumes/X10/projects/noetl/ai-meta

python3 scripts/agent_envelope_carveout_smoke.py     # 8/8
python3 scripts/gap41_diagnosis_wait_smoke.py        # 7/7
python3 scripts/auto_troubleshoot_smoke.py           # 9/9
python3 scripts/optional_ai_smoke.py                 # 6/6
python3 scripts/live_vs_persisted_parity_smoke.py    # 3/3 static
python3 scripts/worker_workload_forwarding_smoke.py  # passing
```

Each smoke validates a specific architectural contract — see
[Agent Failure Diagnostics](../architecture/agent_failure_diagnostics.md)
for what each one protects.

## What you just exercised

The 12 events your spike produced demonstrate every architectural contract
NoETL relies on for self-troubleshooting:

- **Agent envelope contract** — `tool: agent framework=noetl` returned a
  full envelope with `status`, `framework`, `entrypoint`, `error`, and
  `execution_id` fields. Documented in
  [Agent Failure Diagnostics](../architecture/agent_failure_diagnostics.md).
- **Sub-execution wait-for-terminal** — the dispatcher waited for the
  failing sub-playbook to reach terminal state before reading its result.
- **`kind: agent` tool_error carve-out** — `envelope.status: "error"` is
  the contract describing the sub-execution's outcome, not a step-level
  failure of the dispatcher. See
  [Agent Orchestration](../architecture/agent_orchestration.md).
- **Auto-troubleshoot hook** — on failure the executor dispatched the
  diagnose agent, waited for its terminal status, and fetched the
  persisted diagnosis from the `persist_diagnosis` step's events.
- **Event projection preservation** — the worker preserved the full
  nested `error.diagnosis._meta.diagnosis_fetch` dict end-to-end through
  `_extract_control_context`. The same projection path preserves
  `render.args` for GUI prompt widgets in noetl v2.37.2.
- **Live-vs-persisted parity** — the assertion script and the parity
  smoke both confirm the persisted shape matches the live response.

## Next steps

- [Build a self-troubleshooting playbook](./03-self-troubleshooting-playbook.md) — compose your own version of this pattern with a worked example.
- [GKE production deploy](./02-gke-production-deploy.md) — same stack, deployed to Google Kubernetes Engine with Vertex AI as the triage backend.
- [Frontend developer onboarding](./04-frontend-onboarding.md) — long-form Auth0 + GraphQL walkthrough for building a UI on top of the gateway.

## Troubleshooting

**`podman machine start` hangs or fails.** Re-init at a smaller memory
(8 GiB) to confirm the host has the resources, then bring it back to 16.
If the machine state is split across `~/.local/share` and `~/Library`,
unset `XDG_DATA_HOME` and run `podman machine list` to see which is
authoritative.

**`kind create cluster` succeeds but `kubectl` connects to nothing.** kind
sometimes leaves stale `kubeconfig` entries. Run
`kind delete cluster --name=noetl-cluster` and recreate. Confirm the
`kind-noetl-cluster` context is current with `kubectl config current-context`.

**Spike returns `attempts > 5` on the first run.** This is the cold-start
signature — Ollama hadn't loaded `gemma3:4b` into resident memory before
the diagnose call ran. Subsequent runs reuse warm state and drop to
`attempts ≤ 1`. The cloud-latency profile is documented in
[Vertex AI Triage Backend](../architecture/vertex_ai_triage_backend.md).

**`/api/health` returns 502 or never responds.** The noetl-server pod
crashed or never became Ready. `kubectl -n noetl describe pod -l app=noetl-server`
will show the pull or startup failure. If GHCR is rate-limiting, wait a
minute and retry — the `bump_image` GHCR probe typically catches this
before the rollout times out.

**`ollama list` is empty after pull completes.** The Ollama pod restarted
mid-pull and the partial download was discarded. `kubectl -n noetl rollout restart deploy/ollama`
and re-pull. Models are stored on the pod's emptyDir; persisting them across
pod restarts is part of [Local Podman Kind Cluster](../operations/local-cluster.md).
