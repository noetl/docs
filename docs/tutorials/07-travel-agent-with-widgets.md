---
title: 'Tutorial 7 — Travel agent with widgets (NoETL DSL as templating for AI + MCP)'
sidebar_label: '7. Travel agent + widgets'
sidebar_position: 7
description: 'Flagship demo — a natural-language travel agent built from playbooks alone. Shows NoETL DSL as the templating layer for AI providers and MCP tools, with widgets as JSON over the wire.'
---

# Tutorial 7 — Travel agent with widgets

This tutorial walks through a flagship demo: a natural-language travel
agent built entirely from NoETL playbooks. It takes a free-text query
("flights from SFO to JFK on July 15"), classifies intent through
OpenAI or Anthropic, calls the right Amadeus
endpoint, and returns the result as a widget tree that renders in
both the terminal-style prompt and the travel canvas.

The point isn't the travel agent specifically — it's that you can
build this kind of agentic flow with **NoETL DSL alone**:

- The AI provider switch is a small branch-and-merge graph. Keychain
  entries bind unconditionally with bare workload references, direct
  HTTP providers stay in Python, and complex or in-cluster providers
  route through MCP playbook hops.
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
- At least one AI provider path. OpenAI is the default, Anthropic is
  supported when its secret exists, Vertex AI routes through
  `automation/agents/mcp/vertex-ai`, and Ollama routes through
  `automation/agents/mcp/ollama` to the in-cluster bridge at
  `http://ollama-bridge.noetl.svc.cluster.local:8765/jsonrpc`.

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

You can also ask for hotels, activities, locations, or help:

```text
travel hotels in Paris on 2026-08-15
travel activities near Times Square
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
  capabilities: [mcp:amadeus, mcp:vertex-ai, mcp:ollama, ai:openai, ai:anthropic, ai:vertex-ai, ai:ollama]

workload:
  ai_provider: openai          # openai | anthropic | vertex-ai | ollama
  query: "Help"
  amadeus_env: test
  vertex_project: noetl-demo-19700101
  vertex_region: us-central1
  vertex_model: gemini-2.5-flash
  ollama_model: gemma3:4b
  ollama_bridge_url: http://ollama-bridge.noetl.svc.cluster.local:8765/jsonrpc

keychain:
  - name: openai_token
    auth: "{{ gcp_auth }}"
    map: { api_key: "{{ openai_secret_path }}" }
  - name: anthropic_token
    auth: "{{ gcp_auth }}"
    map: { api_key: "{{ anthropic_secret_path }}" }
  # Amadeus OAuth — same for every run regardless of AI provider.
  - name: amadeus_credentials
    auth: "{{ gcp_auth }}"
    map:
      client_id: "{{ amadeus_key_path }}"
      client_secret: "{{ amadeus_secret_path }}"
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
  - step: classify_via_http_provider
    tool:
      kind: python
      input:
        query: "{{ workload.query }}"
        requested_provider: "{{ workload.ai_provider }}"
        openai_api_key: "{{ keychain.openai_token.api_key | default('') }}"
        anthropic_api_key: "{{ keychain.anthropic_token.api_key | default('') }}"
  - step: classify_via_vertex_mcp
    tool:
      kind: agent
      framework: noetl
      entrypoint: automation/agents/mcp/vertex-ai
      payload:
        model: "{{ workload.vertex_model }}"
        messages:
          - role: user
            content: "{{ workload.query }}"
        vertex_project: "{{ workload.vertex_project }}"
        vertex_region: "{{ workload.vertex_region }}"
        vertex_model: "{{ workload.vertex_model }}"
  - step: classify_via_ollama_mcp
    tool:
      kind: agent
      framework: noetl
      entrypoint: automation/agents/mcp/ollama
      payload:
        method: tools/call
        tool: chat_completion
        arguments:
          model: "{{ workload.ollama_model }}"
          messages:
            - role: user
              content: "{{ workload.query }}"
          ollama_endpoint: "{{ workload.ollama_bridge_url }}"
  - step: classify_intent
    tool:
      kind: python
  # ... classify_intent merger -> branch by intent -> render as workflow tail ...
```

That's the thesis: keychain stays boring and unconditional, while the
normal workflow steps own provider selection, response unwrapping, and
fallback metadata.

## Step 3 — Pluggable AI provider

The classifier is now a small branch-and-merge graph. The HTTP branch
handles OpenAI and Anthropic. The Vertex branch calls the Vertex AI
MCP playbook through `tool: agent` / `framework: noetl`. The Ollama
branch uses the same NoETL agent hop shape against
`automation/agents/mcp/ollama`, which wraps the in-cluster
`ollama-bridge` JSON-RPC endpoint at
`http://ollama-bridge.noetl.svc.cluster.local:8765/jsonrpc`. A final
`classify_intent` Python step merges whichever branch ran and emits the
same uniform fields for every downstream branch:
`intent`, `origin`, `destination`, `departureDate`, `adults`, `city`,
`cityCode`, `keyword`, `latitude`, `longitude`,
`effective_provider`, `provider_fallback_reason`, and `json_str` for
SQL audit.

```python
if requested_provider == "vertex-ai":
    vertex_text = read_text_from_vertex_mcp_child_execution()
    parsed = json.loads(_strip_markdown_fences(vertex_text) or "{}")
    effective_provider = "vertex-ai"
elif requested_provider == "ollama":
    ollama_text = read_text_from_ollama_mcp_child_execution()
    parsed = json.loads(_strip_markdown_fences(ollama_text) or "{}")
    effective_provider = "ollama"
else:
    parsed, effective_provider = classify_with_openai_or_anthropic()

result = normalize_to_travel_contract(parsed, effective_provider)
result["json_str"] = json.dumps(result, separators=(",", ":"))
```

The code follows the
[Playbook authoring guide](../reference/playbook_authoring_guide.md):
bare keychain references, no keychain `when:` predicates, no Jinja
conditionals for provider-specific URLs, and pre-serialized JSON for
SQL audit.

Switching among supported classifiers is one workload field:

```text
travel --provider openai flights from SFO to JFK on July 15
travel --provider anthropic locations near Boston
travel --provider vertex-ai flights from SFO to JFK on 2026-07-15
travel --provider ollama help
travel --provider ollama flights from SFO to JFK on 2026-07-15
```

The `--provider` flag in NoetlPrompt's `travel` verb threads the
chosen provider into the workload. The rendered status pill shows the
actual `effective_provider`, so a successful Vertex run says
`effective_provider=vertex-ai` and a successful local-model run says
`effective_provider=ollama`. If Anthropic is requested but its secret is
unavailable, or if a provider MCP playbook returns a clean MCP error
envelope, the classifier snaps back to OpenAI and records a
`provider_fallback_reason` in the result envelope.

Vertex AI is intentionally routed through
`automation/agents/mcp/vertex-ai`, mirroring the Phase 2 Amadeus
pattern. The travel agent dispatches; the MCP playbook owns GCP auth:
Workload Identity, metadata server, env-var token, and
service-account JWT fallback. One auth implementation serves two
callers: `travel --provider vertex-ai ...` and external MCP clients
speaking JSON-RPC to
`/api/mcp/playbook/automation/agents/mcp/vertex-ai/jsonrpc`.

The step shape is the same NoETL agent hop used for Amadeus:

```yaml
- step: classify_via_vertex_mcp
  tool:
    kind: agent
    framework: noetl
    entrypoint: automation/agents/mcp/vertex-ai
    payload:
      model: "{{ workload.vertex_model }}"
      messages:
        - role: user
          content: "{{ workload.query }}"
      system: |
        You are a travel agent classifier. Return only JSON.
      temperature: 0
      vertex_project: "{{ workload.vertex_project }}"
      vertex_region: "{{ workload.vertex_region }}"
      vertex_model: "{{ workload.vertex_model }}"
```

After running a Vertex-backed query, inspect the events endpoint to
prove the MCP hop:

```bash
curl -s http://localhost:8082/api/executions/<execution-id>/events \
  | jq '.events[]
      | select(.node_name == "classify_via_vertex_mcp")
      | select(.event_type == "command.completed")
      | {
          step: .node_name,
          framework: .result.context.framework,
          entrypoint: .result.context.entrypoint,
          sub_execution_id: .result.context.execution_id
        }'
```

Expected output includes `framework: "noetl"`, the
`automation/agents/mcp/vertex-ai` entrypoint, and a
`sub_execution_id`.

Ollama follows the same pattern. The new `automation/agents/mcp/ollama`
playbook exposes `chat_completion` while translating internally to the
bridge's raw `chat` tool. That keeps travel's provider surface symmetric
with Vertex AI while still using the existing in-cluster bridge service
and local `gemma3:4b` model.

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
                {"type": "app:statusbar", "args": {"text": f"effective_provider={provider}", "styleKey": "info"}},
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

Each intent branch is now a render-as-tail workflow path:

| Intent | Amadeus MCP tool | Render shape |
| --- | --- | --- |
| `flights` | `search_flights` | `app:carousel` of flight offer cards |
| `hotels` | `search_hotels` | `app:recordtable` with hotel name, chain, city, and geo fields |
| `locations` | `search_locations` | `app:recordtable` with airport/city lookup fields |
| `activities` | `search_activities` | `app:recordtable` with activity name, type, geo, and price fields |

All four branches share the same agent-to-MCP hop pattern. The travel
runtime chooses the intent, calls `automation/agents/mcp/amadeus` with
`tool: agent` / `framework: noetl`, and makes the matching render step
the workflow tail so `execution.result.render` is the widget payload.
The travel audit table follows the same rule: each render step writes
its `travel_agent_events` row as a best-effort side effect inside the
rendering Python code. That preserves the round-6 render-as-tail
contract; a trailing `kind: postgres` audit step would become the last
step and overwrite the widget result.

### Refinement forms

Each result widget can also include an `app:form` that lets the
operator adjust the search without retyping the whole prompt. The
form's field IDs become placeholders in the button event value. At
click time, `repos/gui/src/components/widgets/AppForm.tsx`
substitutes `{fieldId}` with the current form value, then emits the
result as a normal widget command. The terminal prompt and travel
canvas already route `key: "command"` events back into the prompt
runner.

For example, the flights branch appends a form like this:

```python
{
    "type": "app:form",
    "args": {
        "fields": [
            {"id": "origin", "title": "Origin (IATA)", "default_value": classification.get("origin") or "SFO"},
            {"id": "destination", "title": "Destination (IATA)", "default_value": classification.get("destination") or "JFK"},
            {"id": "departureDate", "title": "Departure date", "default_value": classification.get("departureDate") or "2026-07-15"},
            {"id": "adults", "title": "Adults", "default_value": str(classification.get("adults") or 1)},
        ],
        "buttons": [{
            "text": "Refine search",
            "colorType": "primary",
            "event": {
                "key": "command",
                "value": "travel flights from {origin} to {destination} on {departureDate} for {adults} adults",
            },
        }],
    },
}
```

The same convention powers the hotel, location, activity, and
friendly-error refinement forms. Static string events still emit as-is,
and non-string form events keep the older values-object behavior.

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

In Phase 2 and the hotels/activities follow-up, the travel agent uses
this MCP playbook internally too. The flights, hotels, locations, and
activities branches call
`automation/agents/mcp/amadeus` through `tool: agent` /
`framework: noetl`, passing a `tools/call` payload for
`search_flights`, `search_hotels`, `search_locations`, or
`search_activities`. External MCP callers and the travel agent now
share the same Amadeus implementation.

After running a travel query, inspect the execution events to prove
the agent-to-MCP hop happened:

```bash
curl -s http://localhost:8082/api/executions/<execution-id>/events \
  | jq '.events[]
      | select(.node_name | test("amadeus_via_mcp"))
      | select(.event_type == "command.completed")
      | {
          step: .node_name,
          framework: .result.context.framework,
          entrypoint: .result.context.entrypoint,
          sub_execution_id: .result.context.execution_id
        }'
```

Expected output includes `framework: "noetl"`, the
`automation/agents/mcp/amadeus` entrypoint, and a `sub_execution_id`,
showing that the travel runtime delegated to the MCP playbook rather
than calling Amadeus directly.

The **important point** is that "MCP is just a playbook" is now
load-bearing. Wrap a capability as an MCP playbook
(`exposes_as_mcp: true`) when you want it discoverable as a tool to
other agents; call that same playbook from an agent flow when you
want a cohesive user-facing command.

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

- **Pluggable providers**: OpenAI and Anthropic share the HTTP
  provider branch, while Vertex AI is delegated to the Vertex AI MCP
  playbook. Provider-specific shape drift stays local to those
  branches, and downstream branches read the uniform classification
  fields plus `effective_provider`.
- **Pluggable surfaces**: the agent (single flow) and the MCP server
  (tool catalog) now share the same Amadeus playbook implementation.
  The catalog kinds (`Playbook`, `Mcp`, `Credential`) make discovery
  uniform.
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

- **Provider parity smokes** continue as environment work: Vertex AI
  requires the target deployment's Workload Identity or ADC path to
  reach Vertex AI, Anthropic requires its secret, and Ollama still
  needs the in-cluster bridge URL wired in the target cluster.

## Related references

- [`gui/widgets.md`](../gui/widgets.md) — widget rendering contract
- [`tutorials/06-widget-rendering.md`](./06-widget-rendering.md) —
  prior tutorial on basic widget rendering
- [`architecture/playbook_as_mcp_server.md`](../architecture/playbook_as_mcp_server.md) —
  the pattern the Amadeus MCP server playbook implements
- [`architecture/agent_orchestration.md`](../architecture/agent_orchestration.md) —
  how agent playbooks compose
