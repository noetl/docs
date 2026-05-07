---
title: 'Add a new MCP backend'
sidebar_label: '05 · Add a new MCP backend'
sidebar_position: 5
description: 'Advanced. Build a new MCP backend behind the JSON-RPC contract used by mcp/ollama and mcp/vertex-ai. Worked example: AWS Bedrock or Azure OpenAI. About 2 hours.'
---

# Add a new MCP backend

> **Status:** stub. The full walkthrough is queued for a subsequent
> tutorial round. The structure below names every step plus the
> existing reference doc that covers it.

This tutorial walks you through extending the NoETL platform with a new
triage backend behind the same JSON-RPC contract used by `mcp/ollama`
and `mcp/vertex-ai`. The worked example uses AWS Bedrock as the
hypothetical new backend, but the same pattern applies to Azure
OpenAI, Anthropic on AWS, or any future provider.

By the end you'll have a stub-then-real backend, registered in catalog,
exercised end-to-end via workload override, and added to the parity
smoke fixtures. Future contributors can use your work as the template
for the next backend.

Estimated time: 2 hours.

## Prerequisites

{/* TODO */}
- Completed [Self-troubleshooting playbook](./03-self-troubleshooting-playbook.md).
- Familiar with the
  [MCP-as-playbook pattern](../architecture/playbook_as_mcp_server.md)
  and the
  [Agent Failure Diagnostics contract](../architecture/agent_failure_diagnostics.md).
- (For the worked example) AWS account with Bedrock model access in at
  least one region.

## Why pointer-swap, not branching

{/* TODO:
  - Recap the architectural design from
    architecture/vertex_ai_triage_backend.md "Why Pointer-Swap, Not
    Branching"
  - The diagnose_execution agent calls mcp/<server> via JSON-RPC;
    swapping mcp/ollama for mcp/bedrock should be a config change,
    not a code change.
*/}

## Step 1 — Pick your hypothetical backend

{/* TODO:
  - For this tutorial: AWS Bedrock with Claude 3.5 Sonnet
  - Mention alternatives: Azure OpenAI (gpt-4o), Together AI
    (open-source models), Anthropic on AWS (Claude direct)
  - The shape is identical; the credential surface differs
*/}

## Step 2 — Define the JSON-RPC contract

{/* TODO:
  - Show the tools/list response shape: chat_completion tool with
    input schema {model, messages, system, temperature}
  - Show the tools/call request shape and the expected response:
    {content: [{type: "text", text: "..."}], isError: bool, _meta: {...}}
  - The contract is identical to mcp/ollama and mcp/vertex-ai —
    that's the whole point. Reference repos/ops/automation/agents/mcp/vertex-ai-stub.yaml
    as the template.
*/}

## Step 3 — Build the stub first

{/* TODO:
  - Walk through copying vertex-ai-stub.yaml to bedrock-stub.yaml
  - Modify the canned chat_completion response to include source: "bedrock-stub"
  - Add mock _meta.usage with realistic prompt_tokens / completion_tokens
  - Register in catalog: noetl catalog register
  - The stub-first pattern is documented in the architectural design;
    the prior round (ops#39) shipped vertex-ai-stub for exactly this
    reason — proves the pointer-swap before you commit to the real
    cloud calls.
*/}

## Step 4 — Wire the pointer-swap

{/* TODO:
  - Run the spike with workload override: triage_mcp_server: mcp/bedrock-stub
  - Confirm the diagnosis source is "bedrock-stub"
  - Walk the events to show the swap worked end-to-end
  - This validates your backend's JSON-RPC contract conforms
*/}

## Step 5 — Implement the real backend

{/* TODO:
  - Move from stub to real:
    1. Replace canned response with actual API call
    2. Bedrock: AWS SDK + IAM role via service account
    3. Convert messages → Bedrock's converse API format
    4. Handle streaming vs non-streaming (same as Vertex; pick non-streaming for the diagnose path)
    5. Map response → MCP chat_completion contract
    6. Populate _meta.usage from Bedrock's usage telemetry
  - Credential surface options:
    - IAM role via service account (preferred, GKE Workload Identity-equivalent)
    - Static API keys (acceptable for dev)
    - AWS profiles (for local testing)
  - Each backend's MCP playbook encapsulates its own credential pattern;
    diagnose_execution doesn't branch on backend type.
*/}

## Step 6 — Add a parity smoke fixture

{/* TODO:
  - Open scripts/live_vs_persisted_parity_smoke.py
  - Add a static fixture for the new backend's response shape
  - The fixture should pass parity (live vs persisted shape match)
  - Add a regression fixture: same shape but with _meta stripped on the
    persisted side — should detect NESTED_DICT_LOSS
  - This is the "explicit carve-out + parity test" prescription from
    bridge/outbox/event_projection_audit.md operationalized for new
    backends
*/}

## Step 7 — Document model name mapping

{/* TODO:
  - Open docs/architecture/triage_model_selection.md
  - Add a row to the model-mapping table:
    - bedrock-stub: gemma3:4b ↔ claude-3-haiku
    - bedrock-stub: qwen3:32b ↔ claude-3.5-sonnet (escalation)
  - Operators picking bedrock get a clear mapping from local-tier to
    bedrock-tier model identities
*/}

## Step 8 — Validation sweep

{/* TODO:
  - Run all 6 ai-meta smokes — all should pass with the new backend
    in place
  - Run the spike on the new backend, confirm:
    - diagnosis source = your backend name
    - _meta.diagnosis_fetch telemetry populated
    - _meta.usage token counts match the cloud provider's response
    - parity smoke catches the regression case (verify by temporarily
      breaking the projection in a feature branch)
*/}

## Next steps

{/* TODO */}
- Open a PR to upstream your new backend playbook to `repos/ops`.
- File a sync issue if you discovered any architectural deltas (e.g.
  Bedrock's converse API maps to a slightly different message schema
  than Vertex's GenerateContent). The pointer-swap pattern depends on
  the JSON-RPC contract being tight; deltas need to be encoded on the
  backend side, not surfaced to the consumer.
- [Triage Model Selection](../architecture/triage_model_selection.md)
  — long-form reference for backend choice and model tier semantics.

## Troubleshooting

{/* TODO: top 5 backend-implementation gotchas
  - JSON-RPC contract drift: forgetting to populate _meta.usage breaks
    operator observability without breaking the spike
  - Credential leakage: cloud provider tokens accidentally logged in
    the diagnose envelope's _meta — never log raw tokens
  - Streaming vs non-streaming: cloud providers default to streaming;
    the diagnose path needs non-streaming for variance reasons
  - Region availability: not all models are available in all regions;
    the diagnose playbook should fail-fast with a clear error if the
    requested model is unavailable
  - Cost: real cloud backends are metered; ensure _meta.usage is
    populated so operators can monitor cost per execution
*/}
