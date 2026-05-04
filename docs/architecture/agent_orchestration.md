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
      ollama_model: gemma2:2b
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

## Workload pass-through to the troubleshoot agent

`on_failure` accepts the troubleshoot agent's workload knobs:

| Key                    | Default                                            | What it controls                       |
|------------------------|----------------------------------------------------|----------------------------------------|
| `troubleshoot`         | `false`                                            | per-task opt-in (overrides env)        |
| `troubleshoot_path`    | `automation/agents/troubleshoot/diagnose_execution`| catalog path of the diagnostic agent   |
| `ollama_model`         | `gemma2:2b`                                        | local model for first-pass triage      |
| `ollama_mcp_server`    | `mcp/ollama`                                       | catalog path of the Ollama MCP bridge  |
| `confidence_threshold` | `0.7`                                              | escalate when local confidence < this  |
| `escalate_to`          | `openai`                                           | `openai` / `claude` / `none`           |
| `openai_credential`    | `openai_token`                                     | keychain entry for the API key         |
| `openai_model`         | `gpt-4o-mini`                                      | OpenAI model for escalation            |
| `noetl_url`            | `http://noetl-server.noetl.svc.cluster.local:8080` | NoETL API base for fetching events     |

Unknown `on_failure` keys are ignored at the troubleshoot dispatch —
they're filtered to the known set so an arbitrary key doesn't leak
into the workload silently.

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
    ollama_model: gemma2:2b
    confidence_threshold: 0.7
    escalate_to: openai
```

## See also

- [Playbook-as-MCP-Server](./playbook_as_mcp_server.md) — the inverse:
  expose any playbook as an MCP tool to external clients.
- [Self-Troubleshoot Agent](./self_troubleshoot_agent.md) — what
  `on_failure.troubleshoot: true` actually invokes.
- [Ollama Bridge](../operations/ollama_bridge.md) — deploying the
  cheap-first inference layer the troubleshoot agent uses.
