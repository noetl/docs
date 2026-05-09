---
id: agent_orchestration
title: Agent Orchestration in NoETL
sidebar_label: Agent Orchestration
sidebar_position: 3
---

# Agent Orchestration in NoETL

How `tool: kind: agent` lets a NoETL playbook dispatch external agent
runtimes — and how `framework: noetl` lets a playbook dispatch *another
playbook* as the agent runtime, without writing any Python glue.

This page is the reference for the agent contract. For the bigger
picture (how playbooks and MCP servers compose into an AI operating
system), see
[NoETL Catalog-Driven MCP Architecture](./mcp_catalog_architecture.md)
and [Playbook-as-MCP-Server](./playbook_as_mcp_server.md).

## Authoring rules

The May 2026 travel agent flagship round surfaced 11 generalizable
rules for playbook authors, spanning keychain templates, handled
failures, render-as-tail workflow shape, third-party HTTP envelopes,
Jinja quoting, and GUI widget event handling. They are collected in the
[Playbook authoring guide](../reference/playbook_authoring_guide.md)
so new agent playbooks can start from the proven patterns instead of
repeating the same AMBER to GREEN fixes.

## The agent envelope

Every `tool: kind: agent` step returns the same shape regardless of
the framework underneath:

```json
{
  "status": "ok" | "error",
  "framework": "adk" | "langchain" | "custom" | "noetl",
  "entrypoint": "<framework-specific identifier>",
  "data": <agent-produced output>,
  "execution_id": "<for noetl framework: sub-playbook execution_id>",
  "duration": <seconds>,
  "error": {                       // only on failure
    "kind": "agent.execution" | "agent.configuration",
    "code": "<symbolic>",
    "message": "<human-readable>",
    "retryable": true | false,
    "diagnosis": { ... }           // optional, see Auto-troubleshoot
  }
}
```

This single envelope is what makes "agents" compose: the caller
doesn't need to know whether the agent was a Python ADK runtime, a
LangChain chain, or a peer NoETL playbook. The shape is the contract.

## Frameworks

| `framework`  | Entrypoint shape                            | What runs                                          |
|--------------|---------------------------------------------|----------------------------------------------------|
| `adk`        | `pkg.module:factory_func`                   | Google ADK runtime, instantiated via the factory   |
| `langchain`  | `pkg.module:chain_or_agent`                 | LangChain chain or agent, invoked via `.ainvoke`   |
| `custom`     | `pkg.module:callable`                       | Any callable; signature is inspected and dispatched|
| `noetl`      | `catalog/path/to/playbook`                  | A peer NoETL playbook, dispatched as a sub-flow    |

Python-loaded frameworks (`adk`, `langchain`, `custom`) require the
target module to be importable from the worker. They're great for
calling out to existing Python agent code without rewriting it as a
playbook. `noetl` is for the inverse: wrapping any registered
playbook so it can be called as if it were an agent.

## `framework: noetl` — playbook ≡ agent

The simplest worked example. A "search flights" playbook already
exists in the catalog at `api_integration/amadeus_ai_api`. Any other
playbook can call it as an agent:

```yaml
- step: ask_amadeus
  tool:
    kind: agent
    framework: noetl
    entrypoint: api_integration/amadeus_ai_api
    invoke_kwargs:
      version: 2
    payload:
      query: "{{ user_query }}"
  next:
    arcs:
      - step: render_results
```

Under the hood, the agent executor:

1. Treats `entrypoint` as a catalog path (no Python import).
2. Merges `payload` and `invoke_kwargs` into the sub-playbook's
   workload.
3. Dispatches via `execute_playbook_task` — the same plugin
   `tool: kind: playbook` uses for fire-and-forget sub-execution.
4. Normalises the plugin's `success` / `error` status into the agent
   envelope's `ok` / `error`.
5. Wires the sub-execution's `execution_id`, `data`, `duration` into
   the envelope so callers can stitch it back into the event log.

This is what makes "any playbook is an MCP tool" work end-to-end:
the playbook-as-MCP-server endpoint
([reference](./playbook_as_mcp_server.md)) takes an MCP `tools/call`
and dispatches it via the same path.

## Auto-troubleshoot on failure

When a `framework: noetl` sub-playbook fails, the executor can
optionally dispatch the
[self-troubleshoot agent](./self_troubleshoot_agent.md) and attach
the diagnosis directly to the error envelope. Three opt-in levers,
in precedence order:

1. **Per-task** — `task_config.on_failure.troubleshoot: true|false`
2. **Env-level** — `NOETL_AGENT_AUTO_TROUBLESHOOT=1`
3. **Default** — off

Per-task always wins so operators can disable auto-diagnosis on
inner-loop calls where the ~3s diagnostic call's wall-clock would
dominate.

```yaml
- step: ask_amadeus
  tool:
    kind: agent
    framework: noetl
    entrypoint: api_integration/amadeus_ai_api
    payload:
      query: "{{ user_query }}"
    on_failure:
      troubleshoot: true
      triage_mcp_server: mcp/ollama
      triage_model: gemma3:4b
      confidence_threshold: 0.85
      escalate_to: openai
```

When this step fails, the response carries:

```json
{
  "status": "error",
  "framework": "noetl",
  "entrypoint": "api_integration/amadeus_ai_api",
  "execution_id": "exec-failed-1",
  "error": {
    "kind": "agent.execution",
    "code": "PLAYBOOK_FAILED",
    "message": "...",
    "retryable": false,
    "diagnosis": {
      "category": "transient_5xx",
      "confidence": 0.82,
      "root_cause": "Amadeus sandbox returned HTTP 502",
      "suggested_action": "Retry; if persistent, check api.amadeus.com status",
      "source": "ollama",
      "escalated": false
    }
  }
}
```

A recursion guard prevents the troubleshoot agent from auto-diagnosing
its own failures. If the troubleshoot agent itself fails, the original
error envelope is returned unchanged — diagnostics augment failures,
they never replace them.

## Detecting projection regressions

Auto-troubleshoot depends on the worker and server preserving nested
control metadata through event projection. The important contract is
that a failed agent envelope can persist nested diagnosis data at:

```text
result.context.error.diagnosis
```

When this regresses, the live step response may contain a diagnosis, but
the persisted terminal events lose the nested object. The same projection
discipline now covers GUI render descriptors at `result.context.render.args`
so [prompt widgets](../gui/widgets.md) survive from worker event to persisted
execution document. Operators should run the parity smoke any time event
projection, worker terminal events, auto-troubleshoot handling, or render
descriptor projection changes.

Run the static fixture smoke from the `ai-meta` checkout. It does not
need a cluster:

```bash
cd /Volumes/X10/projects/noetl/ai-meta
python3 scripts/live_vs_persisted_parity_smoke.py
```

Expected output includes both:

```text
OK static v2.35.9-shaped fixture preserves nested diagnosis
OK static v2.35.8-regression fixture detected NESTED_DICT_LOSS at result.context.error.diagnosis
```

To validate a live cluster, first run a spike or any execution that
exercises an auto-troubleshoot-enabled failing agent, then pass the
execution id to the smoke:

```bash
EXEC_ID=$(noetl exec tests/spike/spike_e2e_test \
  --runtime distributed \
  --payload '{"escalate_to":"none"}' \
  --json | jq -r '.execution_id')

noetl status "${EXEC_ID}" --json > /tmp/noetl-spike-${EXEC_ID}.json

python3 scripts/spike_e2e_assert.py /tmp/noetl-spike-${EXEC_ID}.json
python3 scripts/live_vs_persisted_parity_smoke.py --execution-id "${EXEC_ID}"
```

The parity smoke compares nested dictionary key sets across terminal
events for each step. A failure such as
`NESTED_DICT_LOSS at result.context.error.diagnosis` means the diagnosis
was present in one projection but lost in another, and should block a
release until the projection path is fixed.

## Workload pass-through to the troubleshoot agent

`on_failure` accepts the troubleshoot agent's workload knobs:

| Key                    | Default                                            | What it controls                       |
|------------------------|----------------------------------------------------|----------------------------------------|
| `troubleshoot`         | `false`                                            | per-task opt-in (overrides env)        |
| `troubleshoot_path`    | `automation/agents/troubleshoot/diagnose_execution`| catalog path of the diagnostic agent   |
| `triage_model`         | `gemma3:4b`                                        | model for first-pass triage            |
| `triage_mcp_server`    | `mcp/ollama`                                       | catalog path of the triage MCP backend |
| `confidence_threshold` | `0.7`                                              | escalate when local confidence < this  |
| `escalate_to`          | `openai`                                           | `openai` / `claude` / `none`           |
| `openai_credential`    | `openai_token`                                     | keychain entry for the API key         |
| `openai_model`         | `gpt-4o-mini`                                      | OpenAI model for escalation            |
| `noetl_url`            | `http://noetl-server.noetl.svc.cluster.local:8080` | NoETL API base for fetching events     |

Unknown `on_failure` keys are ignored at the troubleshoot dispatch —
they're filtered to the known set so an arbitrary key doesn't leak
into the workload silently. `triage_*` is the canonical naming surface;
the older `ollama_*` aliases were removed after the worker started
forwarding `triage_*` keys generically.

## Optional-dependency contract

**AI features in NoETL are optional.** A deployment can run the
worker + server without ever touching `tool: kind: agent
framework=noetl`, the playbook-as-MCP-server endpoint, the Ollama
bridge, or the self-troubleshoot agent. Core workflow execution
must keep working when those subsystems are missing.

The contract this enforces:

- **No worker / server crashes when an AI subsystem is missing.**
  Module-level imports for AI-only paths are stdlib-only;
  optional packages (`aiohttp`, `fastapi`, `uvicorn`) are
  lazy-imported inside the functions that need them. A deployment
  without those packages still loads the noetl modules cleanly.
- **Playbook steps surface clean error envelopes, not tracebacks.**
  When `framework: noetl` is invoked but
  `noetl.core.workflow.playbook` can't be imported, the agent
  executor returns a structured error with
  `error.kind = "agent.dependency"` and
  `error.code = "WORKFLOW_PLUGIN_UNAVAILABLE"`. The worker keeps
  running; the playbook step fails with a clear "this feature is
  not available" message; non-AI playbooks are unaffected.
- **Auto-troubleshoot best-effort.** When the troubleshoot agent
  itself can't be reached (Ollama down, agent not registered, the
  workflow plugin failed to import), the original error envelope
  is returned unchanged. Diagnostics augment failures, never
  replace them.
- **Other agent frameworks unaffected.** `framework: adk`,
  `langchain`, `custom` go through a separate dispatch path that
  doesn't touch the workflow plugin. A deployment without the
  AI subsystems can still use Python-loaded agent runtimes.

The smoke test
[`scripts/optional_ai_smoke.py`](https://github.com/noetl/ai-meta/blob/main/scripts/optional_ai_smoke.py)
exercises the contract: it loads the executor with
`noetl.core.workflow.playbook` deliberately missing and verifies
the structured error envelope; it asserts `execute_playbook_task`
references are confined to the framework=noetl helpers; it loads
`noetl.tools.ollama_bridge` and asserts no optional packages
leaked into `sys.modules`.

## Configuration reference

```yaml
tool:
  kind: agent

  # One of: adk | langchain | custom | noetl
  framework: noetl

  # For framework=noetl: catalog path. Otherwise: 'pkg.module:attr'.
  entrypoint: api_integration/amadeus_ai_api

  # Catalog version pin (framework=noetl only). Default: latest.
  version: 2

  # Workload-equivalent payload merged into the sub-flow's input.
  payload:
    query: "{{ user_query }}"

  # Extra kwargs merged on top of payload (caller-side overrides).
  invoke_kwargs:
    timeout_s: 30

  # framework=adk|langchain|custom only:
  entrypoint_mode: factory   # 'factory' (default) or 'callable'
  entrypoint_args: {}        # kwargs passed to factory
  invoke_method: run_async   # explicit method override

  # Auto-troubleshoot hook (framework=noetl only).
  on_failure:
    troubleshoot: true
    troubleshoot_path: automation/agents/troubleshoot/diagnose_execution
    triage_mcp_server: mcp/ollama
    triage_model: gemma3:4b
    confidence_threshold: 0.7
    escalate_to: openai
```

## See also

- [Playbook-as-MCP-Server](./playbook_as_mcp_server.md) — the inverse:
  expose any playbook as an MCP tool to external clients.
- [Self-Troubleshoot Agent](./self_troubleshoot_agent.md) — what
  `on_failure.troubleshoot: true` actually invokes.
- [Catalog UX](../gui/catalog-ux.md) and
  [Widgets in output](../gui/widgets.md) — how catalog resources and
  `render: { type, args }` results surface in the terminal-style prompt.
- [Ollama Bridge](../operations/ollama_bridge.md) — deploying the
  cheap-first inference layer the troubleshoot agent uses.
- [Triage Model Selection](./triage_model_selection.md) — how to choose
  between `gemma3:4b`, `gemma4:e4b`, and escalation models without
  changing the catalog default.
- [Agent Failure Diagnostics Contract](./agent_failure_diagnostics.md) —
  the Gap 1 / Gap 4.1 wait, carve-out, projection, and smoke-test
  contracts behind failed agent executions.
