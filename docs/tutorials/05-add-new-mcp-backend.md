---
title: 'Add a new MCP backend'
sidebar_label: '05 · Add a new MCP backend'
sidebar_position: 5
description: 'Advanced. Build a new MCP backend behind the JSON-RPC contract used by mcp/ollama and mcp/vertex-ai. Worked example: AWS Bedrock. About 2 hours.'
---

# Add a new MCP backend

This tutorial extends the NoETL platform with a new triage backend
behind the same JSON-RPC contract used by `mcp/ollama` and
`mcp/vertex-ai`. The worked example uses **AWS Bedrock with Claude
3.5 Sonnet** — same pattern applies to Azure OpenAI, Together AI,
direct Anthropic, or any future provider.

By the end you'll have a stub-then-real backend, registered in
catalog, exercised end-to-end via workload override, with parity-smoke
fixtures extending the regression-detection net to the new shape.

Estimated time: 2 hours.

## Prerequisites

- Completed [Self-troubleshooting playbook](./03-self-troubleshooting-playbook.md)
  so you understand the auto-troubleshoot dispatch path.
- Familiar with the
  [MCP-as-playbook pattern](../architecture/playbook_as_mcp_server.md)
  and the
  [Agent Failure Diagnostics contract](../architecture/agent_failure_diagnostics.md).
- (For the worked example) AWS account with Bedrock model access in
  at least one region. Bedrock requires per-account model
  enablement — see "Step 1" troubleshooting if your first call
  returns 403.

## Why pointer-swap, not branching

The `diagnose_execution` agent doesn't know what backend it's calling.
It calls `mcp/<server>` via JSON-RPC; whichever MCP server is
registered at that catalog path responds. Swapping `mcp/ollama` for
`mcp/bedrock` is a config change, not a code change to the agent or
the worker.

This is the architectural payoff documented in
[Vertex AI Triage Backend → Why Pointer-Swap, Not Branching](../architecture/vertex_ai_triage_backend.md).
The contract you implement in this tutorial is the same one
`mcp/ollama` and `mcp/vertex-ai` already implement. The catalog
becomes the discriminator; operator-supplied workload overrides do
the per-request routing.

## Step 1 — Pick your hypothetical backend

For this tutorial: **AWS Bedrock with Claude 3.5 Sonnet** as the
triage tier and Claude 3 Opus as the escalation tier. Substitute as
appropriate:

| Backend           | Triage model                  | Escalation model         | Credential surface          |
|-------------------|-------------------------------|--------------------------|------------------------------|
| AWS Bedrock       | `claude-3-5-haiku-20241022`   | `claude-3-5-sonnet`      | IAM role via service account |
| Azure OpenAI      | `gpt-4o-mini`                 | `gpt-4o`                 | Managed Identity / API key   |
| Together AI       | `meta-llama/Llama-3.3-70B`    | `Qwen/Qwen2.5-72B`       | API key                      |
| Direct Anthropic  | `claude-3-5-haiku-20241022`   | `claude-3-5-sonnet`      | API key                      |

Confirm Bedrock model access in your account before starting:

```bash
aws bedrock list-foundation-models \
  --region=us-east-1 \
  --query "modelSummaries[?contains(modelId, 'haiku') || contains(modelId, 'sonnet')].[modelId,modelName]" \
  --output table
```

If the list is empty, you need to request model access in the Bedrock
console (per-region, per-model). Operator decision; not something the
playbook should automate.

## Step 2 — Define the JSON-RPC contract

Every MCP triage backend implements the same `chat_completion` tool:

`chat_completion` is the protocol-level tool name inherited from the
MCP backend contract. It does not imply a chat UI; NoETL surfaces the
diagnosis through execution events, prompt reports, and any structured
`render` descriptor the playbook emits.

**`tools/list` response shape:**

```json
{
  "tools": [
    {
      "name": "chat_completion",
      "description": "Generate a chat completion from messages",
      "inputSchema": {
        "type": "object",
        "properties": {
          "model": { "type": "string" },
          "messages": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "role": { "enum": ["system", "user", "assistant"] },
                "content": { "type": "string" }
              }
            }
          },
          "system": { "type": "string" },
          "temperature": { "type": "number" }
        },
        "required": ["model", "messages"]
      }
    }
  ]
}
```

**`tools/call` request:** `{ name: "chat_completion", arguments: <input matching schema> }`.

**`tools/call` response shape:**

```json
{
  "content": [{ "type": "text", "text": "<assistant reply>" }],
  "isError": false,
  "_meta": {
    "backend": "bedrock",
    "model": "anthropic.claude-3-5-haiku-20241022-v1:0",
    "usage": {
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "total_tokens": 0
    }
  }
}
```

The `_meta.usage` field is the cost-telemetry surface every backend
must populate. The `_meta.backend` field disambiguates the source in
events; consumers like the spike fixture's assertion script look at
this to confirm the right path was exercised.

The reference template is
[`repos/ops/automation/agents/mcp/vertex-ai-stub.yaml`](https://github.com/noetl/ops/blob/main/automation/agents/mcp/vertex-ai-stub.yaml).
Copy it as the starting point — the JSON-RPC scaffolding is identical
across backends; only the upstream call changes.

## Step 3 — Build the stub first

The stub returns canned responses with the right shape, no real cloud
calls. Lets you validate the pointer-swap and the contract before
committing to credential plumbing. This is the same pattern that
shipped `mcp/vertex-ai-stub` in [ops#39](https://github.com/noetl/ops/pull/39)
before the real `mcp/vertex-ai` arrived in
[ops#40](https://github.com/noetl/ops/pull/40).

Create `repos/ops/automation/agents/mcp/bedrock-stub.yaml`:

```yaml
apiVersion: noetl.io/v2
kind: Mcp
metadata:
  name: bedrock-stub
  path: mcp/bedrock-stub
  description: |
    Stub MCP backend for AWS Bedrock. Returns canned chat_completion
    responses so the pointer-swap can be validated end-to-end before
    real Bedrock credentials and SDK calls are wired in.
  tags: [aws, bedrock, mcp, stub, triage]

spec:
  protocol: mcp/1.0
  provider: aws
  managed: false

  tools:
    - name: chat_completion
      description: Canned chat completion (stub)
      inputSchema:
        type: object
        properties:
          model: { type: string }
          messages: { type: array }
          system: { type: string }
          temperature: { type: number }
        required: [model, messages]

  runtime:
    type: playbook
    inline:
      - step: build_response
        tool: python
        code: |
          # Canned diagnosis matching the troubleshoot agent's contract
          diagnosis = {
            "category": "transient_5xx",
            "confidence": 0.78,
            "root_cause": "Stubbed Bedrock response — replace with real Bedrock API call",
            "suggested_action": "Wire AWS Bedrock IAM credentials and replace this stub.",
            "source": "bedrock-stub",
            "escalated": False,
          }
          result = {
            "content": [{"type": "text", "text": diagnosis["root_cause"]}],
            "isError": False,
            "_meta": {
              "backend": "bedrock-stub",
              "model": model,
              "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
              },
            },
            "diagnosis": diagnosis,
          }
        args:
          model: "{{ workload.model }}"
        next: [end]
      - step: end
        type: end
```

Register in catalog:

```bash
noetl catalog register repos/ops/automation/agents/mcp/bedrock-stub.yaml
```

## Step 4 — Wire the pointer-swap

Validate the stub responds to the same `triage_mcp_server` workload
override that `mcp/vertex-ai-stub` does:

```bash
EXEC_ID=$(noetl run tests/spike/spike_e2e_test \
  --runtime distributed \
  --payload '{
    "escalate_to": "none",
    "triage_mcp_server": "mcp/bedrock-stub",
    "triage_model": "anthropic.claude-3-5-haiku-20241022-v1:0"
  }' \
  --json | jq -r '.execution_id')

sleep 30
noetl status "$EXEC_ID" --json > /tmp/bedrock_stub_spike.json
python3 scripts/spike_e2e_assert.py /tmp/bedrock_stub_spike.json
```

Confirm `diagnosis source: bedrock-stub` in the assertion output.
Walk the events to confirm the canned `_meta.usage` made it through
projection:

```bash
python3 - <<'PY'
import json
with open('/tmp/bedrock_stub_spike.json') as f:
    doc = json.load(f)
for evt in doc.get('events', []):
    diag = evt.get('result', {}).get('context', {}).get('error', {}).get('diagnosis')
    if isinstance(diag, dict) and diag.get('source') == 'bedrock-stub':
        print(f"event {evt.get('event_id')} backend = {diag.get('_meta', {}).get('backend')}")
        print(f"  model = {diag.get('_meta', {}).get('model')}")
        print(f"  usage = {diag.get('_meta', {}).get('usage')}")
        break
PY
```

If those fields come back populated, the contract is right. Now
replace the stub with real Bedrock calls.

## Step 5 — Implement the real backend

Add `repos/ops/automation/agents/mcp/bedrock.yaml` (no `-stub` suffix
— production playbook lives at the unsuffixed path):

```yaml
apiVersion: noetl.io/v2
kind: Mcp
metadata:
  name: bedrock
  path: mcp/bedrock
  description: |
    AWS Bedrock MCP backend for diagnostic triage. Uses the Bedrock
    Converse API. Authenticates via IAM role via the GKE Workload
    Identity binding (or SDK's default credential chain locally).
  tags: [aws, bedrock, mcp, triage]

spec:
  protocol: mcp/1.0
  provider: aws
  managed: false

  auth:
    type: aws_iam
    role_env: AWS_ROLE_ARN
    region_env: AWS_REGION

  tools:
    - name: chat_completion
      description: Bedrock Converse chat completion
      inputSchema:
        type: object
        properties:
          model: { type: string }
          messages: { type: array }
          system: { type: string }
          temperature: { type: number }
        required: [model, messages]

  runtime:
    type: playbook
    inline:
      - step: bedrock_converse
        tool: python
        code: |
          import os, boto3, json

          region = os.environ.get("AWS_REGION", "us-east-1")
          client = boto3.client("bedrock-runtime", region_name=region)

          # Convert OpenAI-style messages to Bedrock Converse format.
          # Bedrock wants {role, content: [{text}]} — strip system from
          # the message list and pass it via systemPrompts.
          conv_messages = []
          system_prompts = []
          if system_prompt:
              system_prompts.append({"text": system_prompt})
          for msg in messages:
              role = msg.get("role")
              if role == "system":
                  system_prompts.append({"text": msg.get("content", "")})
                  continue
              conv_messages.append({
                  "role": role,
                  "content": [{"text": msg.get("content", "")}],
              })

          response = client.converse(
              modelId=model,
              messages=conv_messages,
              system=system_prompts or None,
              inferenceConfig={
                  "temperature": temperature,
                  "maxTokens": 1024,
              },
          )

          # Extract text from output. Bedrock returns
          # {output: {message: {role, content: [{text}]}}, usage: {...}}.
          text = ""
          for block in response.get("output", {}).get("message", {}).get("content", []):
              if "text" in block:
                  text = block["text"]
                  break

          usage = response.get("usage", {})
          stop_reason = response.get("stopReason")

          result = {
            "content": [{"type": "text", "text": text}],
            "isError": False,
            "_meta": {
              "backend": "bedrock",
              "model": model,
              "request_id": response.get("ResponseMetadata", {}).get("RequestId"),
              "usage": {
                "prompt_tokens": usage.get("inputTokens", 0),
                "completion_tokens": usage.get("outputTokens", 0),
                "total_tokens": usage.get("totalTokens", 0),
              },
              "stop_reason": stop_reason,
            },
          }
        args:
          model: "{{ workload.model }}"
          messages: "{{ workload.messages }}"
          system_prompt: "{{ workload.system | default('') }}"
          temperature: "{{ workload.temperature | default(0.0) }}"
        next: [end]
      - step: end
        type: end
```

A few things worth understanding:

- **Credential surface**: `boto3.client("bedrock-runtime")` uses the
  AWS SDK's default credential chain — IAM role via service account
  on EKS/GKE-with-IRSA-equivalent, instance profile on EC2, or
  `~/.aws/credentials` locally. No tokens in the playbook YAML;
  no service-account JSON anywhere.
- **Message conversion**: OpenAI-style `{role, content}` flattens to
  Bedrock's `{role, content: [{text}]}`. System messages move to
  `systemPrompts` rather than prepending to the user message — same
  decision Vertex AI's adapter makes for the same reason
  (consistency in how the model sees system instructions across
  turns).
- **Response shape**: `_meta.usage` populated from Bedrock's
  `usage.{inputTokens, outputTokens, totalTokens}` — Bedrock uses
  different field names than OpenAI, so the adapter normalizes.
  `_meta.request_id` from the AWS response metadata gives operators
  a cross-correlation key into CloudWatch logs. `_meta.stop_reason`
  surfaces Bedrock's stop reason (e.g. `end_turn`,
  `max_tokens`, `stop_sequence`).

## Step 6 — Add a parity smoke fixture

Per the projection audit's prescription ("explicit carve-outs +
parity tests for future backends"), extend
[`scripts/live_vs_persisted_parity_smoke.py`](https://github.com/noetl/ai-meta/blob/main/scripts/live_vs_persisted_parity_smoke.py)
to cover the Bedrock-shape envelope.

The smoke takes static fixtures of `(live_response, persisted_event)`
pairs and asserts nested-dict shape parity. Add two:

```python
# In scripts/live_vs_persisted_parity_smoke.py, append to the static
# fixtures list:

BEDROCK_LIVE = {
    "result": {
        "context": {
            "error": {
                "kind": "agent.execution",
                "code": "PLAYBOOK_FAILED",
                "diagnosis": {
                    "category": "transient_5xx",
                    "confidence": 0.78,
                    "root_cause": "Bedrock returned 503",
                    "suggested_action": "Retry with backoff",
                    "source": "bedrock",
                    "_meta": {
                        "backend": "bedrock",
                        "model": "anthropic.claude-3-5-haiku-20241022-v1:0",
                        "request_id": "abc-123",
                        "usage": {
                            "prompt_tokens": 220,
                            "completion_tokens": 85,
                            "total_tokens": 305,
                        },
                        "stop_reason": "end_turn",
                    },
                },
            },
        },
    },
}

BEDROCK_PERSISTED_PASS = json.loads(json.dumps(BEDROCK_LIVE))  # deep copy
BEDROCK_PERSISTED_REGRESSION = json.loads(json.dumps(BEDROCK_LIVE))
del BEDROCK_PERSISTED_REGRESSION["result"]["context"]["error"]["diagnosis"]["_meta"]
```

Then add two test cases:

- `(BEDROCK_LIVE, BEDROCK_PERSISTED_PASS)` — must PASS parity check.
- `(BEDROCK_LIVE, BEDROCK_PERSISTED_REGRESSION)` — must FAIL with
  `NESTED_DICT_LOSS at result.context.error.diagnosis._meta`.

Run the smoke to confirm both fixtures behave as expected:

```bash
cd /Volumes/X10/projects/noetl/ai-meta
python3 scripts/live_vs_persisted_parity_smoke.py
```

Expected output: the static-fixture count grows from 3/3 to 5/5
(your two new fixtures + the existing three). If your "must FAIL"
case actually passes, the smoke isn't catching the regression — debug
the comparison logic before trusting it.

## Step 7 — Document model name mapping

Update [`docs/architecture/triage_model_selection.md`](../architecture/triage_model_selection.md)
to add the new backend to the model-mapping table. Append rows
like:

| Tier         | Local            | Vertex                    | Bedrock                                       |
|--------------|------------------|---------------------------|-----------------------------------------------|
| Triage       | `gemma3:4b`      | `gemini-2.5-flash`        | `anthropic.claude-3-5-haiku-20241022-v1:0`    |
| Higher-quality opt-in | `gemma4:e4b` | (operator pick) | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Escalation   | `qwen3:32b`      | `gemini-2.5-pro`          | `anthropic.claude-3-opus-20240229-v1:0`       |

This is operator-facing documentation; pick the model identifiers
you actually validated on real Bedrock calls. Don't paste examples
that haven't been exercised.

## Step 8 — Validation sweep

Run the full smoke battery and the spike with the real Bedrock
backend:

```bash
# All 6 ai-meta smokes pass with the new backend in place
python3 scripts/agent_envelope_carveout_smoke.py
python3 scripts/gap41_diagnosis_wait_smoke.py
python3 scripts/auto_troubleshoot_smoke.py
python3 scripts/optional_ai_smoke.py
python3 scripts/live_vs_persisted_parity_smoke.py     # 5/5 with Bedrock fixtures
python3 scripts/worker_workload_forwarding_smoke.py

# Real Bedrock spike
EXEC_ID=$(noetl run tests/spike/spike_e2e_test \
  --runtime distributed \
  --payload '{
    "escalate_to": "none",
    "triage_mcp_server": "mcp/bedrock",
    "triage_model": "anthropic.claude-3-5-haiku-20241022-v1:0"
  }' \
  --json | jq -r '.execution_id')

sleep 30
noetl status "$EXEC_ID" --json > /tmp/bedrock_real.json
python3 scripts/spike_e2e_assert.py /tmp/bedrock_real.json
```

Expected: GREEN with `diagnosis source: bedrock`, real prompt+completion
token counts (typically 100–300 / 30–100 for the spike's failure
context), and `_meta.request_id` populated with a real AWS request ID
that you can grep CloudWatch for.

If the parity smoke catches anything (your Bedrock response has
nested telemetry that v2.37.1's recursive carve-out doesn't preserve)
that's a real architectural finding — file a sync issue against
noetl-side projection logic, don't paper over it in the playbook.

## Next steps

- Open a PR to upstream your new backend playbook to
  [`noetl/ops`](https://github.com/noetl/ops). The community benefits
  when each cloud backend has a maintained reference implementation.
- File a sync issue if you discovered any architectural deltas
  (e.g. Bedrock's Converse API doesn't surface stop_reason in the
  same shape as Vertex's `finishReason`). The pointer-swap pattern
  depends on the contract being tight; deltas need to encode on the
  backend side, not bubble up to consumers.
- [Triage Model Selection](../architecture/triage_model_selection.md)
  — long-form reference for backend choice and tier semantics now
  that yours is documented.

## Troubleshooting

**Bedrock returns 403 AccessDeniedException on first call.** Per-account
model enablement is required. Open the Bedrock console for your region,
go to "Model access", request access for the Claude family. Approval is
typically immediate but can take up to 30 minutes. Retry once approved.

**Bedrock returns ValidationException on `converse`.** Almost always a
message-schema mismatch — your `messages` array has shape Bedrock
doesn't accept. Common causes: `role: "tool"` (Bedrock uses `assistant`
+ `toolUse` blocks), empty `content`, or `system` passed inside
`messages` instead of `system`. The adapter in step 5 handles the
common cases; if you're proxying messages from a more permissive
source, normalize there.

**Parity smoke catches a regression on Bedrock fixtures.** The most
recent projection-preservation work (noetl#421 / v2.37.1) handles
nested dicts under `error.diagnosis._meta` recursively. If your
Bedrock-shape `_meta` has an additional layer (e.g.
`_meta.usage.cost_breakdown` for fine-grained cost by tokens) and
parity catches it, that means the recursive carve-out has an upper
depth limit it's hitting. File against noetl with the exact shape;
v2.37.1's `max_depth=8` should cover any realistic nesting but a real
backend might exceed it.

**Cost shows up wildly different in CloudWatch vs `_meta.usage`.**
Bedrock's billing tracks input + output tokens separately for some
models with different rates (e.g. Sonnet's input vs output rate).
The `_meta.usage.total_tokens` is sum-of-both; if your operator
dashboard prices on `total_tokens × single_rate`, it'll drift from
the real bill. Surface input + output separately in dashboards and
apply the right rate per direction.

**`mcp/bedrock-stub` left in catalog after going to real.** Keep it
intentionally as a regression-detector — the stub-vs-real swap is
the smallest-possible reproducible test of the pointer-swap. The
stub doesn't ship to production payloads (catalog defaults remain
`mcp/ollama` locally, `mcp/vertex-ai` per-payload-override on GKE),
so it's harmless storage. The architectural scaffolding pattern from
[ops#39](https://github.com/noetl/ops/pull/39) keeps this pair around
permanently.
