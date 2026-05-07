---
title: 'Build a self-troubleshooting playbook'
sidebar_label: '03 · Self-Troubleshooting Playbook'
sidebar_position: 3
description: 'Compose a parent playbook that dispatches a failing sub-playbook, gets a structured diagnosis attached automatically, and routes downstream behavior on the diagnosis category. About 30 minutes.'
---

# Build a self-troubleshooting playbook

This tutorial walks you through composing the full self-troubleshooting
pattern from scratch: a parent playbook that invokes a failing
sub-playbook, receives a structured diagnosis attached to the error
envelope, and routes its downstream behavior on the diagnosis category.

By the end you will have built a working version of the pattern the
spike e2e demonstrates, understand which architectural contract each step
exercises, and know how to switch the triage backend per deployment mode.

Estimated time: 30 minutes. Prereqs: completed
[Quickstart](./01-quickstart.md) with the local cluster up and `gemma3:4b`
loaded.

## What you'll build

Two playbooks:

1. **`failing_canary`** — a deliberately-failing sub-playbook. Always
   raises a clear error so the diagnose agent has something to work with.
2. **`canary_with_diagnosis`** — the parent playbook. Invokes
   `failing_canary` via `tool: agent framework=noetl` with
   `on_failure.troubleshoot: true`, then in its next step extracts a
   useful summary from the attached diagnosis.

When you're done, invoking the parent will:

- Trigger the auto-troubleshoot hook on the failing sub-playbook's error
  envelope.
- Dispatch the `diagnose_execution` agent automatically.
- Wait for the diagnosis sub-execution to reach terminal status.
- Fetch the persisted diagnosis from events.
- Attach the `{category, confidence, root_cause, suggested_action,
  source}` dict to `error.diagnosis`.
- Surface the diagnosis through your `extract_envelope` step into the
  parent's result.

You'll see the same architectural surface the spike e2e exercises, but
with playbooks you wrote yourself.

## Step 1 — The failing sub-playbook

Create `tutorials/playbooks/failing_canary.yaml`:

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: failing_canary
  path: tutorials/failing_canary
  description: |
    A deliberately-failing canary used by the self-troubleshooting tutorial.
    Always raises a clear, structured error.

executor:
  profile: distributed
  version: noetl-runtime/1

workload: {}

workflow:
  - step: simulate_upstream_5xx
    tool: http
    method: GET
    url: "https://this-host-does-not-exist.example.invalid"
    timeout_seconds: 5
```

The `tool: http` call to a non-resolvable host produces a clean
DNS-failure error envelope without depending on any flaky external
service. If you want a different failure mode, swap to a
`tool: python` step that raises a typed exception (`raise
RuntimeError("upstream returned 502")`) — the diagnose agent handles
both shapes.

The shape mirrors the test fixture at
[`repos/e2e/fixtures/playbooks/spike/spike_failing_subflow.yaml`](https://github.com/noetl/e2e/blob/main/fixtures/playbooks/spike/spike_failing_subflow.yaml)
— see that file if you need a richer reference example.

## Step 2 — The parent playbook

Create `tutorials/playbooks/canary_with_diagnosis.yaml`:

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: canary_with_diagnosis
  path: tutorials/canary_with_diagnosis
  description: |
    Parent playbook for the self-troubleshooting tutorial. Invokes
    failing_canary via the agent runtime with auto-troubleshoot
    enabled, then surfaces the diagnosis through extract_envelope.

executor:
  profile: distributed
  version: noetl-runtime/1

workload:
  triage_mcp_server: "mcp/ollama"
  triage_model: "gemma3:4b"
  confidence_threshold: 0.0
  escalate_to: "none"

workflow:
  - step: trigger_failure
    tool: agent
    framework: noetl
    entrypoint: tutorials/failing_canary
    on_failure:
      troubleshoot: true
      triage_mcp_server: "{{ workload.triage_mcp_server }}"
      triage_model: "{{ workload.triage_model }}"
      confidence_threshold: "{{ workload.confidence_threshold }}"
      escalate_to: "{{ workload.escalate_to }}"
    next:
      arcs:
        - step: extract_envelope

  - step: extract_envelope
    tool: python
    code: |
      envelope = trigger_failure if isinstance(trigger_failure, dict) else {}
      error_block = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
      diagnosis = error_block.get("diagnosis") if isinstance(error_block.get("diagnosis"), dict) else {}

      result = {
        "status": "ok",
        "smoke_status": "ok",
        "agent_envelope": envelope,
        "diagnosis": diagnosis,
        "summary": (
          "Canary failed; diagnosed as "
          f"{diagnosis.get('category', '<no category>')} "
          f"(confidence {diagnosis.get('confidence', 0.0):.2f}); "
          f"suggested: {diagnosis.get('suggested_action', '<no suggestion>')}"
        ),
      }
    args:
      trigger_failure: "{{ trigger_failure }}"
    next:
      arcs:
        - step: end

  - step: end
    type: end
```

A few points worth noting:

- **`triage_*` keys are the canonical names** since v2.36.0 (the worker
  forwards them generically). The deprecated `ollama_mcp_server` /
  `ollama_model` aliases were removed in `ops#42`. See
  [Triage Model Selection](../architecture/triage_model_selection.md)
  for the full naming history.
- **`confidence_threshold: 0.0` + `escalate_to: "none"`** means the
  Ollama-only triage owns the diagnosis. Set `escalate_to: "openai"` or
  `"claude"` and raise the threshold if you want escalation when the
  cheap-first model isn't sure.
- **`extract_envelope` reads `error.diagnosis` directly**. The
  auto-troubleshoot hook runs inside the worker — by the time
  `extract_envelope` executes, the diagnosis is already attached to the
  envelope your `trigger_failure` step received.

## Step 3 — Register both playbooks

```bash
noetl catalog register tutorials/playbooks/failing_canary.yaml
noetl catalog register tutorials/playbooks/canary_with_diagnosis.yaml
```

Catalog registration is idempotent — re-running bumps the version
without breaking anything. Confirm both are visible:

```bash
noetl catalog list | grep tutorials
```

## Step 4 — Invoke the parent

```bash
EXEC_ID=$(noetl exec tutorials/canary_with_diagnosis \
  --runtime distributed \
  --payload '{}' \
  --json | jq -r '.execution_id')
echo "execution: $EXEC_ID"

# Wait for terminal — typically 5–10 seconds with warm gemma3:4b.
sleep 15
curl -sf "http://localhost:8082/api/executions/$EXEC_ID" > /tmp/canary.json
```

Pull the parent's terminal result:

```bash
python3 -c "
import json
with open('/tmp/canary.json') as f:
    doc = json.load(f)
print(doc.get('result', {}).get('summary'))
"
```

You should see something like:

```text
Canary failed; diagnosed as transient_5xx (confidence 0.71); suggested: Retry with exponential backoff; check upstream availability if persistent
```

The exact category and wording will vary — `gemma3:4b` is doing real
inference on the failure context. Common categories for the
non-resolvable-host failure: `transient_5xx`, `infra`, or `unknown`.

## Step 5 — Walk the events

The chronological event flow shows each architectural contract
activating in order:

```bash
python3 - <<'PY'
import json
with open('/tmp/canary.json') as f:
    doc = json.load(f)

for evt in doc.get('events', []):
    print(f"{evt.get('event_type','?'):25} {evt.get('node_name','?'):25} {evt.get('status','?')}")
PY
```

The flow you should see:

```text
command.issued            trigger_failure           PENDING
command.completed         trigger_failure           COMPLETED   <-- agent envelope ready
command.issued            extract_envelope          PENDING
call.done                 extract_envelope          COMPLETED
step.exit                 extract_envelope          COMPLETED
command.completed         extract_envelope          COMPLETED
...                       end                       COMPLETED
```

The interesting event is `trigger_failure → command.completed`. Inspect
its `result.context.error`:

```bash
python3 - <<'PY'
import json
with open('/tmp/canary.json') as f:
    doc = json.load(f)

for evt in doc.get('events', []):
    if evt.get('node_name') == 'trigger_failure' and evt.get('event_type') == 'command.completed':
        error = evt.get('result', {}).get('context', {}).get('error', {})
        diag = error.get('diagnosis', {})
        print(f"error.kind        = {error.get('kind')}")
        print(f"error.code        = {error.get('code')}")
        print(f"diagnosis.category = {diag.get('category')}")
        print(f"diagnosis.source   = {diag.get('source')}")
        print(f"_meta.diagnosis_fetch = {diag.get('_meta', {}).get('diagnosis_fetch')}")
        break
PY
```

You'll see all five required diagnosis keys plus the `_meta.diagnosis_fetch`
telemetry block — proof that the projection chokepoint preserved nested
content end-to-end.

## What just happened, architecturally

Each contract you exercised:

**Agent envelope contract.** `tool: agent framework=noetl` waited for
`failing_canary` to reach terminal status, built a full envelope with
`{status: "error", framework: "noetl", entrypoint, error, execution_id}`,
and surfaced that envelope as `trigger_failure`'s result. See
[Agent Failure Diagnostics → Gap 1](../architecture/agent_failure_diagnostics.md).

**`kind: agent` tool_error carve-out.** Even though
`envelope.status == "error"`, the worker did NOT translate that into a
step-level failure for `trigger_failure`. The envelope IS the contract;
downstream steps inspect it. Without this carve-out, `trigger_failure`
would have failed and `extract_envelope` would never have run. See
[Agent Orchestration](../architecture/agent_orchestration.md).

**Auto-troubleshoot hook (Gap 4.1).** Because `on_failure.troubleshoot`
was true and the envelope's status was error, the dispatcher invoked
`automation/agents/troubleshoot/diagnose_execution`, waited for that
sub-execution to reach terminal status, fetched the persisted diagnosis
from the `persist_diagnosis` step's events, and attached the result to
`error.diagnosis` before returning the envelope to `trigger_failure`.

**Event projection preservation.** The worker's `_extract_control_context`
helper preserved the entire nested `error.diagnosis` dict, including
the `_meta.diagnosis_fetch` telemetry, through the strict event-projection
layer. See
[Vertex AI Triage Backend → Cloud latency](../architecture/vertex_ai_triage_backend.md)
for the telemetry schema.

## Step 6 — Variation: route on diagnosis category

Diagnoses have a `category` field that maps to a small fixed set:
`transient_5xx`, `auth`, `rate_limit`, `bad_request`, `tool_error`,
`infra`, `unknown`. Route on it to make the parent playbook
self-correcting:

```yaml
  - step: trigger_failure
    tool: agent
    framework: noetl
    entrypoint: tutorials/failing_canary
    on_failure:
      troubleshoot: true
      triage_mcp_server: "{{ workload.triage_mcp_server }}"
      triage_model: "{{ workload.triage_model }}"
    case:
      - when: "{{ trigger_failure.error.diagnosis.category == 'transient_5xx' }}"
        next: retry_after_backoff
      - when: "{{ trigger_failure.error.diagnosis.category == 'auth' }}"
        next: fail_loud
      - when: "{{ trigger_failure.error.diagnosis.category == 'rate_limit' }}"
        next: schedule_retry
      - default:
          next: extract_envelope

  - step: retry_after_backoff
    tool: python
    code: |
      import time
      time.sleep(5)
      result = {"action": "retried after 5s backoff"}
    next: extract_envelope

  - step: fail_loud
    tool: python
    code: |
      raise RuntimeError(
          f"Auth failure diagnosed: {diagnosis.get('root_cause')}"
      )
    args:
      diagnosis: "{{ trigger_failure.error.diagnosis }}"

  - step: schedule_retry
    tool: python
    code: |
      result = {"action": "deferred to retry queue"}
    next: extract_envelope
```

The `case` block evaluates against `call.done` (since the agent envelope
is the contract; the step itself doesn't fail even though the
sub-execution did). Each branch handles a different diagnosis category
appropriately. This is the building block for self-correcting workflows
— the diagnosis is structured enough that branching logic can be
written against it.

## Step 7 — Switch backends

The same playbook works on a GKE cluster with Vertex AI as the triage
backend. The catalog defaults are deployment-mode-aware: local kind
keeps `mcp/ollama`, GKE catalog operators pass overrides per payload.
See [Vertex AI Triage Backend](../architecture/vertex_ai_triage_backend.md)
for the full architecture.

To run your tutorial against a Vertex backend:

```bash
noetl --server https://gateway.your-gke.example/api/noetl \
  exec tutorials/canary_with_diagnosis \
  --runtime distributed \
  --payload '{
    "triage_mcp_server": "mcp/vertex-ai",
    "triage_model": "gemini-2.5-flash",
    "escalate_to": "none"
  }'
```

The diagnosis source field will read `vertex-ai` instead of `ollama`,
and `_meta.diagnosis_fetch.elapsed_seconds` will land in the 1–3 second
range typical for cloud inference (versus the sub-100ms range for warm
local Ollama). Both are within the adaptive retry budget; both produce
a usable diagnosis dict.

## What you just learned

You built a complete self-troubleshooting playbook by composing four
contracts: the agent envelope, the `kind: agent` carve-out, the
auto-troubleshoot hook, and event projection preservation. The diagnosis
dict is structured well enough to drive `case` branching, which means
your playbooks can become self-correcting without you writing any
backend-specific failure-handling code.

## Next steps

- [Add a new MCP backend](./05-add-new-mcp-backend.md) — the advanced version, where you build a new triage backend behind the same JSON-RPC contract (e.g. AWS Bedrock).
- [Triage Model Selection](../architecture/triage_model_selection.md) — full reference for model tier choices and the deployment-mode-aware backend pattern.
- [Self-Troubleshoot Agent](../architecture/self_troubleshoot_agent.md) — the canonical reference for how `diagnose_execution` works internally.

## Troubleshooting

**Diagnosis arrives empty (`category`, `confidence` etc. all missing).**
Most often `escalate_to` is set to a backend that isn't configured
(e.g. `"openai"` without an API key). The Ollama path silently
short-circuits and returns no diagnosis. Check the diagnose
sub-execution's events for the actual failure.

**`attempts > 5` on the spike fixture poll counter.** Cold-start —
Ollama hadn't loaded `gemma3:4b` into resident memory before the
diagnose call ran. Subsequent runs reuse warm state. The
[cloud-latency profile](../architecture/vertex_ai_triage_backend.md)
documents the expected ranges per backend.

**`category` consistently comes back `unknown`.** The triage model
isn't getting enough signal from the failure context. Two options: raise
`confidence_threshold` to force escalation, or add more structured
context to your sub-playbook's error path so the model has more to work
with (specifically: a typed exception with a useful message beats a
generic `RuntimeError`).

**`extract_envelope` sees `trigger_failure.error` as `None`.** The
agent envelope wasn't attached. Most likely cause: the executor's
`_dispatch_troubleshoot_diagnosis` didn't run because `troubleshoot`
wasn't truthy in `on_failure`. Confirm the `on_failure.troubleshoot:
true` line is present and the `kind:agent` step's failure is reaching
the auto-troubleshoot path (you'll see a diagnose sub-execution in
`/api/executions` if it did).
