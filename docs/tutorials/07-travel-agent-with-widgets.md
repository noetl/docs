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

- The AI provider switch lives in one Python step. Keychain entries
  bind unconditionally with bare workload references, and the step
  chooses OpenAI or Anthropic request/response shapes at runtime.
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
- At least one AI provider API key in your secret manager. OpenAI is
  the default; Anthropic is supported as the second provider. Vertex
  AI and Ollama are deferred provider rounds because they need
  different authentication and routing patterns.

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
  capabilities: [mcp:amadeus, ai:openai, ai:anthropic]

workload:
  ai_provider: openai          # openai | anthropic
  query: "Help"
  amadeus_env: test

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
  - step: classify_intent
    tool:
      kind: python
      input:
        query: "{{ workload.query }}"
        requested_provider: "{{ workload.ai_provider }}"
        openai_api_key: "{{ keychain.openai_token.api_key | default('') }}"
        anthropic_api_key: "{{ keychain.anthropic_token.api_key | default('') }}"
  # ... classify_intent -> branch by intent -> render as workflow tail ...
```

That's the thesis: keychain stays boring and unconditional, while the
normal workflow step owns provider selection, response unwrapping, and
fallback metadata.

## Step 3 — Pluggable AI provider

The classify step is a single Python step. It picks the provider,
builds the right request shape, unwraps the provider-specific response
shape, and emits the same uniform fields for every downstream branch:
`intent`, `origin`, `destination`, `departureDate`, `adults`, `city`,
`keyword`, `effective_provider`, `provider_fallback_reason`, and
`json_str` for SQL audit.

```python
requested = (requested_provider or "openai").strip().lower()
effective_provider = requested if requested in ("openai", "anthropic") else "openai"
provider_fallback_reason = None

if requested == "anthropic" and not (anthropic_api_key or "").strip():
    effective_provider = "openai"
    provider_fallback_reason = "anthropic token missing"

text = _anthropic_text() if effective_provider == "anthropic" else _openai_text()
parsed = json.loads(_strip_markdown_fences(text) or "{}")

result = {
    "intent": _normalise_intent(parsed.get("intent")),
    "origin": _coerce(parsed.get("origin")),
    "destination": _coerce(parsed.get("destination")),
    "departureDate": _coerce(parsed.get("departureDate")),
    "adults": int(parsed.get("adults") or 1),
    "city": _coerce(parsed.get("city")),
    "keyword": _coerce(parsed.get("keyword")),
    "requested_provider": requested,
    "effective_provider": effective_provider,
    "provider_fallback_reason": provider_fallback_reason,
}
result["json_str"] = json.dumps(result, separators=(",", ":"))
```

The code follows the
[Playbook authoring guide](../reference/playbook_authoring_guide.md):
bare keychain references, no keychain `when:` predicates, no Jinja
conditionals for provider-specific URLs, and pre-serialized JSON for
SQL audit.

Switching between the two supported classifiers is one workload field:

```text
travel --provider openai flights from SFO to JFK on July 15
travel --provider anthropic locations near Boston
travel --provider anthropic flights from SFO to JFK on 2026-07-15
```

The `--provider` flag in NoetlPrompt's `travel` verb threads the
chosen provider into the workload. The rendered status pill shows the
actual `effective_provider`, so an Anthropic run says
`effective_provider=anthropic`. If Anthropic is requested but its
secret is not available in the environment, the classifier snaps back
to OpenAI and records `provider_fallback_reason="anthropic token
missing"` in the result envelope.

Vertex AI and Ollama stay deferred in
`sync/issues/2026-05-09-travel-agent-widget-flagship.md`: Vertex needs
a `gcp_access_token` / ADC design pass, and Ollama needs the in-cluster
bridge URL wired in the target cluster.

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

- **Pluggable providers**: OpenAI and Anthropic share one merged
  `classify_intent` Python step. Provider-specific shape drift stays
  local to that step, and downstream branches read the uniform
  classification fields plus `effective_provider`.
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
- **Phase 3** is provider parity smokes — adding Vertex AI and Ollama
  once their auth/routing designs are ready, then running all
  providers through the same intent branches.

## Related references

- [`gui/widgets.md`](../gui/widgets.md) — widget rendering contract
- [`tutorials/06-widget-rendering.md`](./06-widget-rendering.md) —
  prior tutorial on basic widget rendering
- [`architecture/playbook_as_mcp_server.md`](../architecture/playbook_as_mcp_server.md) —
  the pattern the Amadeus MCP server playbook implements
- [`architecture/agent_orchestration.md`](../architecture/agent_orchestration.md) —
  how agent playbooks compose
