---
title: 'Tutorial 7 — Travel agent with widgets (NoETL DSL as templating for AI + MCP)'
sidebar_label: '7. Travel agent + widgets'
sidebar_position: 7
description: 'Flagship demo — a natural-language travel agent built from playbooks alone. Shows NoETL DSL as the templating layer for AI providers and MCP tools, with widgets as JSON over the wire.'
---

# Tutorial 7 — Travel agent with widgets

This tutorial walks through a flagship demo: a natural-language travel
agent built entirely from NoETL playbooks. It takes a free-text query
("flights from SFO to JFK on July 15"), classifies intent through any
chat-completions-compatible AI provider, calls the right Amadeus
endpoint, and returns the result as a widget tree that renders in
both the terminal-style prompt and the travel canvas.

The point isn't the travel agent specifically — it's that you can
build this kind of agentic flow with **NoETL DSL alone**:

- The AI provider is just an HTTP step. The URL, headers, and request
  body template by `workload.ai_provider`. Swap OpenAI for Vertex AI
  / Anthropic / Ollama by changing one workload field.
- The Amadeus MCP server is just another playbook —
  `automation/agents/mcp/amadeus.yaml` exposes `tools/list` and
  `tools/call` per the MCP spec, so any MCP client (Claude Desktop,
  another agent playbook, the prompt's `cd /mcp/amadeus`) talks to it
  the same way.
- The widget output is a JSON discriminator union. The same
  `result.render` shape that round 2's
  [widget renderer](../gui/widgets.md) consumes in the terminal
  prompt is also rendered by the travel canvas.

Nothing in the agentic surface is bespoke Python plug-ins. It's all
templates, HTTP, and a JSON output contract.

## Prerequisites

- A working NoETL deployment (local kind or GKE).
- The widget renderer round shipped — GUI v1.10.0+ in your kind
  cluster.
- Amadeus test API credentials in your secret manager
  (`api-key-test-api-amadeus-com`, `api-secret-test-api-amadeus-com`).
- At least one AI provider API key in your secret manager (OpenAI is
  the default; Anthropic / Vertex / Ollama work too — see the
  pluggable-provider section).

## Step 1 — Register and run the agent

The travel agent playbook lives at
`repos/ops/automation/agents/travel/runtime.yaml`. Register it in the
catalog:

```bash
noetl register repos/ops/automation/agents/travel/runtime.yaml
```

Run it from the prompt with the new `travel` verb:

```text
noetl@kind:/catalog$ travel flights from SFO to JFK on July 15 for 2 adults
started travel agent :: execution=622712345678901234
```

Within a few seconds the auto-render watcher (round 2.x.0) attaches a
fresh prompt entry below the textual report — a `Travel agent · 6
flights` carousel with carrier / departure / duration / price per
card, plus rerun and "open execution detail" buttons.

You can also ask for help or location lookups:

```text
travel locations near Boston
travel help
```

The agent classifies the intent and routes to the right Amadeus
endpoint or to a help renderer.

## Step 2 — Read the agent

Open `repos/ops/automation/agents/travel/runtime.yaml`. The shape:

```yaml
metadata:
  agent: true
  capabilities: [mcp:amadeus, ai:openai, ai:vertex-ai, ai:anthropic, ai:ollama]

workload:
  ai_provider: openai          # openai | vertex-ai | anthropic | ollama
  query: "Help"
  amadeus_env: test

keychain:
  - name: openai_token
    when: "{{ workload.ai_provider == 'openai' }}"
    map: { api_key: "{{ workload.openai_secret_path }}" }
  - name: anthropic_token
    when: "{{ workload.ai_provider == 'anthropic' }}"
    map: { api_key: "{{ workload.anthropic_secret_path }}" }
  - name: vertex_token
    kind: gcp_access_token
    when: "{{ workload.ai_provider == 'vertex-ai' }}"
  # Amadeus OAuth — same for every run regardless of AI provider.
  - name: amadeus_credentials
    map:
      client_id: "{{ workload.amadeus_key_path }}"
      client_secret: "{{ workload.amadeus_secret_path }}"
  - name: amadeus_token
    kind: oauth2
    auto_renew: true
    endpoint: "https://test.api.amadeus.com/v1/security/oauth2/token"
    method: POST
    data:
      grant_type: client_credentials
      client_id: "{{ keychain.amadeus_credentials.client_id }}"
      client_secret: "{{ keychain.amadeus_credentials.client_secret }}"

workflow:
  - step: classify_intent
    tool:
      kind: http
      method: POST
      url: "{{ ... templated by workload.ai_provider ... }}"
      headers: { ... templated by workload.ai_provider ... }
      payload: { ... templated by workload.ai_provider ... }
  # ... parse_classification → branch by intent → render → persist ...
```

That's the thesis: the Jinja conditionals make a single HTTP step
work against any provider.

## Step 3 — Pluggable AI provider

The classify step's URL is a Jinja conditional:

```yaml
url: |
  {{
    'https://api.openai.com/v1/chat/completions' if workload.ai_provider == 'openai'
    else ('https://us-central1-aiplatform.googleapis.com/v1/projects/' ~ workload.gcp_project ~ '/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent') if workload.ai_provider == 'vertex-ai'
    else 'https://api.anthropic.com/v1/messages' if workload.ai_provider == 'anthropic'
    else (workload.ollama_bridge_url ~ '/v1/chat/completions')
  }}
```

Headers and request body are similar conditionals. Switching providers
is one workload field:

```text
travel --provider vertex-ai flights from SFO to JFK on July 15
travel --provider anthropic locations near Boston
travel --provider ollama help
```

The `--provider` flag in NoetlPrompt's `travel` verb threads the
chosen provider into the workload. The `keychain` block uses
`when:` predicates so only the matching provider's token is bound for
the run.

## Step 4 — Widget output

The agent's render steps build a `result.render` widget tree per
intent:

```python
render = {
    "type": "app:column",
    "args": {
        "gap": 8,
        "children": [
            {"type": "app:title", "args": {"text": f"Travel agent · {len(offers)} flights"}},
            {"type": "app:text", "args": {"title": "Query", "message": query}},
            {"type": "app:row", "args": {"children": [
                {"type": "app:statusbar", "args": {"text": f"intent=flights", "styleKey": "success"}},
                {"type": "app:statusbar", "args": {"text": f"provider={provider}", "styleKey": "info"}},
            ]}},
            {"type": "app:carousel", "args": {"widgets": [_offer_card(o) for o in offers]}},
            {"type": "app:row", "args": {"children": [
                {"type": "app:button", "args": {"text": "rerun", "event": {"key": "command", "value": f"rerun {execution_id}"}}},
            ]}},
        ],
    },
}
```

The widget renderer (`repos/gui/src/components/widgets/`) dispatches
on `type` to the matching `App<Kind>` component. This is the same
shape the [widget rendering tutorial](./06-widget-rendering.md)
covered — the travel agent just emits richer trees built around real
Amadeus data.

## Step 5 — Same capability via MCP

The Amadeus MCP server lives at
`repos/ops/automation/agents/mcp/amadeus.yaml`. It exposes the same
Amadeus endpoints as MCP tools:

```bash
noetl register repos/ops/automation/agents/mcp/amadeus.yaml
```

In the prompt:

```text
noetl@kind:/catalog$ cd /mcp
noetl@kind:/mcp$ ls
mcp :: model context server workspaces
- kubernetes
- amadeus

noetl@kind:/mcp$ cd /mcp/amadeus
noetl@kind:/mcp/amadeus$ tools
amadeus tools :: 5
search_flights · search_hotels · search_locations · search_activities · get_token

noetl@kind:/mcp/amadeus$ call search_flights origin=SFO destination=JFK departureDate=2026-07-15
search_flights :: completed
... offers JSON ...
```

Same Amadeus capability, two surfaces — the agent calls the HTTP
endpoint directly; the MCP server playbook wraps it as an MCP tool.

The **important point** isn't that we have two ways to call Amadeus;
it's that NoETL gives you both for free. Wrap a capability as an
agent playbook (single coherent flow) when you want it to feel like
a CLI command. Wrap it as an MCP playbook (`exposes_as_mcp: true`)
when you want it discoverable as a tool to other agents.

## Step 6 — Travel canvas (rich UI)

The travel canvas at `/travel` (`GatewayAssistant.tsx`) renders the
same result. Visit it in the GUI, type a query, and the assistant
calls the agent playbook in direct mode. The widget renderer
(same `WidgetRenderer` component as in the prompt) materialises the
agent's `result.render` below the chat bubble. Buttons emitted by
the agent (`rerun`, `open detail`) work the same way they do in the
prompt.

**Two surfaces, one playbook, one widget contract.**

## Why this matters

You can build agentic flows like the travel agent without writing any
Python plug-ins, without forking NoETL, without standing up a
separate AI gateway. The DSL is the templating layer:

- **Pluggable providers**: any chat-completions-compatible AI is one
  Jinja conditional away. Provider-specific shape drift (Vertex's
  `contents`/`parts`, Anthropic's `system` field) is handled in a
  small `parse_classification` Python step that marshals the response
  into a uniform schema.
- **Pluggable surfaces**: the agent (single flow) and the MCP server
  (tool catalog) wrap the same capability. The catalog kinds
  (`Playbook`, `Mcp`, `Credential`) make discovery uniform.
- **Pluggable rendering**: the result is just JSON. The terminal
  prompt and the travel canvas both render it because both use the
  same WidgetRenderer.
- **Pluggable persistence**: the postgres event-log step records who
  asked what and which provider answered. Add a different kind for a
  different audit sink — that's another playbook step away.

The thesis isn't "NoETL is a workflow engine." It's "NoETL is the
templating library you'd write if you set out to build agentic flows
without committing to a specific AI provider, MCP framework, or
rendering surface."

## What's next

- **Phase 2** of this round adds the Amadeus MCP server's
  agent-to-MCP plumbing so the travel agent can use the MCP tools
  internally rather than calling Amadeus HTTP directly.
- **Phase 3** is provider parity smokes — running the agent against
  all four providers to confirm the parameterisation works in
  practice.

## Related references

- [`gui/widgets.md`](../gui/widgets.md) — widget rendering contract
- [`tutorials/06-widget-rendering.md`](./06-widget-rendering.md) —
  prior tutorial on basic widget rendering
- [`architecture/playbook_as_mcp_server.md`](../architecture/playbook_as_mcp_server.md) —
  the pattern the Amadeus MCP server playbook implements
- [`architecture/agent_orchestration.md`](../architecture/agent_orchestration.md) —
  how agent playbooks compose
