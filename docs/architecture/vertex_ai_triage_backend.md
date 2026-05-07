---
id: vertex_ai_triage_backend
title: Vertex AI Triage Backend
sidebar_label: Vertex AI Triage Backend
sidebar_position: 7
---

# Vertex AI Triage Backend

This page describes the planned Vertex AI / Gemini backend for the
NoETL self-troubleshoot path. The first implementation step is a stub
MCP backend that proves the pointer-swap contract end to end. It does
not call Google Cloud; the real Vertex AI / Gemini integration is a
follow-up.

## Why Pointer-Swap, Not Branching

NoETL already treats MCP as a playbook-facing contract. The
playbook-as-MCP work in [noetl#405](https://github.com/noetl/noetl/pull/405)
made a playbook callable through standard JSON-RPC MCP methods, and the
catalog-driven MCP architecture made MCP endpoints first-class catalog
resources.

That means the troubleshoot agent should not branch on "Ollama versus
Vertex" in Python or YAML. It should call an MCP backend through one
contract:

```text
diagnose_execution -> tool.kind=mcp -> mcp/<backend> -> chat completion
```

For local development, `mcp/ollama` points at the in-cluster Ollama
bridge. For GKE or other cloud deployments, an operator can point the
same workload at `mcp/vertex-ai` or `mcp/gemini`. Two deployments, one
diagnose path.

## MCP Backend Contract

Every compatible triage backend must implement standard JSON-RPC MCP
over HTTP:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "chat_completion",
    "arguments": {
      "model": "gemini-2.5-flash",
      "temperature": 0.1,
      "messages": [
        {"role": "user", "content": "{\"execution_id\":\"...\"}"}
      ],
      "system": "Return one JSON diagnosis object."
    }
  }
}
```

The backend may expose `chat` as a compatibility alias, but
`chat_completion` is the portable name for new backends. The response
must include a text content block whose text is a JSON object with the
diagnosis fields consumed by `diagnose_execution`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"category\":\"unknown\",\"confidence\":0.5,\"root_cause\":\"...\",\"suggested_action\":\"...\",\"source\":\"vertex-stub\"}"
      }
    ],
    "isError": false,
    "_meta": {
      "backend": "vertex-ai-stub",
      "model": "gemini-2.5-flash",
      "usage": {
        "prompt_tokens": 1234,
        "completion_tokens": 256,
        "total_tokens": 1490
      }
    }
  }
}
```

The required diagnosis keys are:

- `category`
- `confidence`
- `root_cause`
- `suggested_action`
- `source`

Backends may include `user_message`, model metadata, provider request
ids, and token usage, but callers must not require provider-specific
fields to parse a diagnosis.

## Naming Convention

The old workload names were Ollama-specific:

- `workload.ollama_mcp_server`
- `workload.ollama_model`

The backend is now a triage concern, not an Ollama concern. The
canonical names are:

- `workload.triage_mcp_server`
- `workload.triage_model`

The old names remain as deprecated aliases for one release cycle. The
resolution order is:

1. `triage_mcp_server`
2. `ollama_mcp_server`
3. default `mcp/ollama`

and:

1. `triage_model`
2. `ollama_model`
3. default `gemma3:4b`

This preserves existing payloads while making new workloads read
correctly when the backend is not Ollama.

## Model Name Flow-Through

NoETL passes the selected model string through to the backend. The
backend owns provider-specific validation and mapping.

| Local tier | Cloud analogue | Use |
|---|---|---|
| `gemma3:4b` | `gemini-2.5-flash` | Default triage tier. Fast, low-cost, suitable for common failures. |
| `gemma4:e4b` | `gemini-2.5-flash` | Higher-quality opt-in in this project until a separately approved thinking-capable Vertex model is enabled. |
| `qwen3:32b` | `gemini-2.5-pro` | Escalation tier for low-confidence diagnoses. |

`gemini-2.0-pro` is also a valid operator choice where that SKU is the
approved escalation model for a deployment. The NoETL diagnose path
does not rewrite model names; operators pin the cloud model they want.

## Model availability and the 404 troubleshooting note

During the 2026-05-06 GKE validation for project
`noetl-demo-19700101`, `gemini-2.0-flash` returned Vertex AI HTTP 404,
and `gemini-2.0-flash-001` returned Vertex AI HTTP 404, across both
`us-central1` and `global` endpoint tests. The same Workload Identity
path succeeded with `gemini-2.5-flash`; execution
`620639495284589035` is the validation proof for the working
`mcp/vertex-ai` pointer swap.

Treat a model 404 as an operator-side availability check, not a NoETL
runtime failure. Common causes include:

- Vertex AI Model Garden activation or access being project-specific.
- Region availability differences between `us-central1`, `global`, and
  other Vertex AI locations.
- Project tier or billing restrictions that limit which publisher
  models are available.
- Model lifecycle changes as newer Gemini versions supersede older
  model names.

Operators can enumerate project-visible models with:

```bash
gcloud ai models list --region=us-central1 --project=<project-id>
```

The Vertex AI Model Garden console gives the same availability view
with governance and cost context. NoETL does not recommend activating a
specific model automatically; the model choice is a deployment
decision.

## Cloud latency vs local -- diagnosis fetch telemetry

`diagnosis_lookup.attempts` is still useful as a spike-fixture
regression detector, but operators should monitor the NoETL-side
diagnosis fetch telemetry first. Since noetl v2.37.0 the
post-terminal persisted-diagnosis fetch uses adaptive backoff, and
since noetl v2.37.1 the telemetry is preserved in persisted execution
events under:

```text
result.context.error.diagnosis._meta.diagnosis_fetch
```

The telemetry object contains:

- `poll_count`: how many document reads the NoETL-side fetch loop used.
- `elapsed_seconds`: wall-clock time spent waiting for the persisted
  diagnosis event.
- `deadline_seconds`: the adaptive loop deadline, currently 60 seconds.
- `hit_deadline`: whether the loop gave up before the diagnosis became
  visible.

For **local Ollama** backends such as `mcp/ollama` with `gemma3:4b`,
inference usually takes about 200-500 ms inside the cluster. The
persisted-diagnosis event normally appears on the first fetch. Expect
`diagnosis_fetch.poll_count == 1` in the common case and a small
`elapsed_seconds` value. Anything above one or two polls on the local
path is a regression signal.

For **cloud Vertex AI** backends such as `mcp/vertex-ai` with
`gemini-2.5-flash`, inference includes a network round trip plus
Google's processing time and commonly lands in the 1-3s+ range. Warm
runs can still have `diagnosis_fetch.poll_count == 1`; cold starts can
take more polls but should remain within the 60-second adaptive
deadline. `hit_deadline: true` is the signal to investigate the backend
or event-store path.

The 2026-05-06 GKE six-run sweep measured this directly: all six spike
runs completed with `source=vertex-ai` and `model=gemini-2.5-flash`;
four of six runs had `diagnosis_lookup.attempts <= 1`; two runs needed
two to three attempts, specifically executions `620875219263030195`
and `620877265538122480`.

That sweep motivated the adaptive fetch loop. A later v2.37.0 GKE run
proved the algorithm worked but also exposed that nested telemetry was
being stripped by event projection. noetl v2.37.1 extended the
`error.diagnosis` projection carve-out recursively, making the canonical
evidence path visible; execution `621262477380026909` persisted
`events[15].result.context.error.diagnosis._meta.diagnosis_fetch` with
`poll_count: 1`, `elapsed_seconds: 0.064`, `deadline_seconds: 60.0`,
and `hit_deadline: false`.

## Credential Surface Unification

Each MCP backend playbook encapsulates its own credential pattern:

- Vertex AI on GKE should prefer Workload Identity and the GKE metadata
  server.
- The Gemini API can use an API-key credential when a direct API setup
  is chosen.
- Future AWS Bedrock backends would use IAM roles or web identity.

The diagnose agent should never branch on provider credential details.
It calls `mcp/<backend>` with `model`, `messages`, and temperature. The
backend resolves credentials, calls the provider, and returns the same
MCP envelope.

## Discriminated Default Policy

Backend selection is explicit-only. NoETL should not auto-detect a GKE
metadata server and silently switch from `mcp/ollama` to
`mcp/vertex-ai`.

Environment-dependent defaults are difficult to debug because the same
catalog entry behaves differently in local kind, GKE, CI, and an
operator laptop. Operators declare the backend per deployment or per
workload. The NoETL upstream default remains `mcp/ollama` and
`gemma3:4b`.

## Cost Telemetry Surface

Cloud-managed inference is metered, and the diagnose path runs on every
agent failure. Every cloud MCP backend should return token usage under:

```json
{
  "data": {
    "_meta": {
      "usage": {
        "prompt_tokens": 1234,
        "completion_tokens": 256,
        "total_tokens": 1490
      }
    }
  }
}
```

The MCP result should also carry the same usage object in
`result._meta.usage` when the provider exposes it. The stub backend uses
mock counts so downstream event projection, dashboards, and reports can
be built before the cloud API call lands.

## Streaming Policy

The diagnose path is non-streaming. Automated failure diagnosis needs a
single deterministic response envelope with a parseable JSON body.
Streaming is useful for chat-style interactions, but it adds ordering,
retry, and partial-response ambiguity that is unnecessary for
`diagnose_execution`.

Real Vertex AI / Gemini backends should call non-streaming generate or
chat-completion APIs for this path.

## Migration Path

An operator on a v2.35.9-style cluster can move gradually:

1. Deploy and register the compatible MCP backend, such as
   `mcp/vertex-ai`.
2. Keep the upstream catalog default as `mcp/ollama`.
3. Run one workload with:

   ```json
   {
     "triage_mcp_server": "mcp/vertex-ai",
     "triage_model": "gemini-2.5-flash",
     "escalate_to": "none"
   }
   ```

4. Confirm `diagnose_execution` returns the five required diagnosis
   keys and provider usage metadata.
5. Promote the backend at deployment level only after validation. That
   means an ops fork, Helm value, or environment-specific registration,
   not a NoETL upstream default change.

During the alias window, old payloads using `ollama_mcp_server` and
`ollama_model` still work. New deployment docs should use the
`triage_*` names.

## Related Pages

- [Triage Model Selection](./triage_model_selection.md)
- [Agent Failure Diagnostics](./agent_failure_diagnostics.md)
- [Ollama Bridge Operations](../operations/ollama_bridge.md)
- [NoETL Catalog-Driven MCP Architecture](./mcp_catalog_architecture.md)
