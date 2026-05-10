---
title: Playbook authoring guide - design rules learned from the AI-OS travel agent arc
sidebar_label: Playbook authoring guide
sidebar_position: 4
description: Practical NoETL playbook and GUI integration rules learned while shipping the AI-OS travel agent flagship workflow.
---

# Playbook authoring guide

These rules came from the 9-round travel agent flagship round
(`sync/issues/2026-05-09-travel-agent-widget-flagship.md`). Each rule
is general enough for NoETL playbook and agent authors to use without
repeating the same AMBER to GREEN cycle. The examples are deliberately
small: copy the pattern, then adapt the surrounding workflow to your
agent.

## Keychain rules

### Use bare workload references in keychain templates

NoETL keychain blocks evaluate Jinja with workload values merged into
the top-level scope. Reference workload fields by their bare name, such
as `{{ gcp_auth }}` or `{{ openai_secret_path }}`. Using
`{{ workload.X }}` can render as an empty string and leave downstream
HTTP calls with an empty bearer token.

Good:

```yaml
keychain:
  - name: openai_token
    auth: "{{ gcp_auth }}"
    map:
      api_key: "{{ openai_secret_path }}"
```

Bad:

```yaml
keychain:
  - name: openai_token
    auth: "{{ workload.gcp_auth }}"
    map:
      api_key: "{{ workload.openai_secret_path }}" # binds empty
```

Surfaced in round 2. Evidence:
`bridge/outbox/20260509-054530-travel-keychain-amber-to-green.result.json`.

### Keep OAuth2 keychain endpoint URLs as plain strings

Do not put Jinja conditionals in an OAuth2 keychain endpoint. The
endpoint field is part of credential/token acquisition, and the travel
arc showed that conditional endpoint templates did not render in that
context. Register separate playbooks or construct environment-specific
calls in a normal step when the endpoint really must vary.

Good:

```yaml
keychain:
  - name: amadeus_token
    endpoint: https://test.api.amadeus.com/v1/security/oauth2/token
```

Bad:

```yaml
keychain:
  - name: amadeus_token
    endpoint: "{{ 'https://test.api.amadeus.com' if env == 'test' else 'https://api.amadeus.com' }}/v1/security/oauth2/token"
```

Surfaced in round 2. Evidence:
`bridge/outbox/20260509-054530-travel-keychain-amber-to-green.result.json`.

## Workload defaults

### Match environment-specific workload defaults to where the playbook runs

Workload fields can chain through Jinja, such as
`vertex_project: "{{ workload.gcp_project }}"`. A default-of-a-default is
invisible to every caller that does not override it, so concrete project,
cluster, and region defaults must match the environment where the
playbook is registered and run, not the developer's local sandbox.

Good:

```yaml
workload:
  # GKE project - used by every downstream Jinja chain.
  gcp_project: "noetl-demo-19700101"
  vertex_project: "{{ workload.gcp_project }}"
  vertex_region: "us-central1"
```

Bad:

```yaml
workload:
  # Local kind sandbox name - silently misroutes every GKE caller.
  gcp_project: "noetl-cluster"
  vertex_project: "{{ workload.gcp_project }}"
  vertex_region: "us-central1"
```

Surfaced in Phase 3 vertex-ai re-smoke. Evidence:
`bridge/outbox/20260510-040000-travel-vertex-ai-resmoke.result.json`.

When a playbook truly serves multiple environments, prefer making the
field required with no default and failing fast at registration time, or
set the default to the production environment and require sandbox/local
callers to override it. The inverse, defaulting to local, silently
breaks production. This pairs with the bare-keychain-references rule
above: both expose how Jinja template chains in workload binding can
hide a misconfiguration that only manifests at request time.

## Step semantics

### Use semantic fields instead of `status: failed` for handled failures

`result.status` is not just descriptive metadata. If a step returns
`status: failed`, NoETL treats that step as failed at the workflow
level. For handled upstream failures, keep the execution successful and
put the semantic state in a different field such as `outcome`, `kind`,
or `category`.

Good:

```python
result = {
    "outcome": "amadeus_failure",
    "upstream_status_code": 500,
    "render": render_widget,
}
```

Bad:

```python
result = {
    "status": "failed",
    "upstream_status_code": 500,
    "render": render_widget,
}
```

Surfaced in round 4. Evidence:
`bridge/outbox/20260509-061206-travel-failure-status-amber-to-green.result.json`.

### Make the render-emitting step the workflow tail

NoETL sets `execution.result` from the last step on the executed
branch. If a render-producing step is followed by `postgres`, `http`,
or `noop`, that later step can clobber the render payload. Put audit
inserts and gateway callbacks inside the render step as side effects
when the GUI must read `execution.result.render`.

Good:

```yaml
- step: render_flights
  tool:
    kind: python
    code: |
      # Optional side effects happen here: psycopg audit, urllib callback.
      result = {
          "text": "Flight search complete",
          "render": render_widget,
      }
  # No next.arcs. This is the tail for the branch.
```

Bad:

```yaml
- step: render_flights
  next:
    arcs:
      - step: persist_and_callback

- step: persist_and_callback
  tool:
    kind: postgres
  next:
    arcs:
      - step: end

- step: end
```

Surfaced in round 6. Evidence:
`bridge/outbox/20260509-065650-travel-render-tail-amber-to-green.result.json`.

## External HTTP calls

### Wrap third-party HTTP calls when non-2xx responses are business data

The NoETL HTTP tool currently aborts the step on non-2xx responses
after retries are exhausted. That is right for many infrastructure
calls, but not for agent-facing APIs where a 4xx or 5xx should become
a friendly widget. Until noetl#88 preserves HTTP error response bodies
for conditional routing, use a `kind: python` wrapper with
`urllib.request` and return a uniform envelope.

Good:

```yaml
- step: amadeus_call_flights
  tool:
    kind: python
    code: |
      import json
      import urllib.error
      import urllib.request

      try:
          with urllib.request.urlopen(request, timeout=30) as response:
              result = {
                  "ok": True,
                  "status_code": response.status,
                  "body": json.loads(response.read().decode("utf-8")),
              }
      except urllib.error.HTTPError as exc:
          result = {
              "ok": False,
              "status_code": exc.code,
              "body": json.loads(exc.read().decode("utf-8") or "{}"),
          }
```

Bad:

```yaml
- step: amadeus_search_flights
  tool:
    kind: http
    method: POST
    url: https://test.api.amadeus.com/v2/shopping/flight-offers
    retry:
      max_attempts: 3
```

Surfaced in round 3. Evidence:
`bridge/outbox/20260509-060007-travel-amadeus-urllib-amber-to-green.result.json`.

## YAML and SQL quoting

### Keep integer payload fields as integers

YAML-quoted Jinja renders strings, even when the expression includes an
`| int` filter. Some APIs care about JSON type fidelity, so do not
template numeric fields inside quotes. Hardcode known integer values or
construct the request body in Python and pass the typed object through.

Good:

```yaml
searchCriteria:
  maxFlightOffers: 10
```

Bad:

```yaml
searchCriteria:
  maxFlightOffers: "{{ workload.maxFlightOffers | default(10) | int }}"
```

Surfaced in round 3. Evidence:
`bridge/outbox/20260509-054530-travel-keychain-amber-to-green.result.json`.

### Pre-serialize JSON before inserting it with SQL templates

Inline `tojson | replace` expressions are fragile inside YAML literal
SQL blocks. Serialize the dict into a string in a Python step, then
reference that single string field from SQL and escape apostrophes
there. This mirrors the proven Amadeus e2e pattern.

Good:

```python
result["json_str"] = json.dumps(result, separators=(",", ":"))
```

```sql
'{{ parse_classification.json_str | replace("'", "''") }}'::jsonb
```

Bad:

```sql
'{{ parse_classification | tojson | replace("'", "''") }}'::jsonb
```

Surfaced in round 1. Evidence:
`bridge/outbox/20260509-051749-travel-agent-amber-to-green.result.json`.

## GUI integration

### Grep the GUI for duplicate playbook path constants

When changing the canonical catalog path for a GUI-backed workflow,
search the whole `src/` tree. At least one component and one service
layer may hold separate constants. Updating only the visible component
can leave the execution service pointing at the old playbook.

Good:

```ts
// src/components/GatewayAssistant.tsx
const TRAVEL_PLAYBOOK_PATH = "automation/agents/travel/runtime";

// src/services/gatewayAuth.ts
const PLAYBOOK_NAME = "automation/agents/travel/runtime";
```

Bad:

```ts
// Component updated, service still points to the old fixture.
const TRAVEL_PLAYBOOK_PATH = "automation/agents/travel/runtime";
const PLAYBOOK_NAME = "api_integration/amadeus_ai_api";
```

Surfaced in round 5. Evidence:
`bridge/outbox/20260509-063112-travel-bubble-render-and-canvas-amber-to-green.result.json`.

### Wrap Enter-handling inputs in an explicit form submit guard

`Input.Search` and other Enter-handling inputs can still trigger the
browser's native submit behavior in routed pages. If that submit goes
to `/`, the app router can redirect the user to the default page and
unmount the working surface. Wrap those inputs in a form that calls
`preventDefault()` and dispatches the intended handler.

Good:

```tsx
<form
  onSubmit={(event) => {
    event.preventDefault();
    if (query.trim() && !submitting) onSubmit(query);
  }}
>
  <Input.Search
    value={query}
    onChange={(event) => setQuery(event.target.value)}
    onSearch={onSubmit}
  />
</form>
```

Bad:

```tsx
<Input.Search
  value={query}
  onChange={(event) => setQuery(event.target.value)}
  onSearch={onSubmit}
/>
```

Surfaced in round 7. Evidence:
`bridge/outbox/20260509-065650-travel-render-tail-amber-to-green.result.json`.

### Stop widget button clicks at the widget boundary

Widget buttons are often rendered inside forms, cards, prompt entries,
or routed pages. The widget callback should fire once, and parent
surfaces should not also see the click as form or navigation activity.
Consume the DOM event before emitting the widget event.

Good:

```tsx
onClick={(clickEvent) => {
  clickEvent.preventDefault();
  clickEvent.stopPropagation();
  onWidgetEvent({
    event: "onPressEvent",
    key: event.key,
    value: event.value,
  });
}}
```

Bad:

```tsx
onClick={() =>
  onWidgetEvent({
    event: "onPressEvent",
    key: event.key,
    value: event.value,
  })
}
```

Surfaced in round 8. Evidence:
`bridge/outbox/20260509-155138-canvas-widget-rerun-green.result.json`.

### Preserve `sourcePrompt` for widget-driven reruns

A widget command like `rerun <execution_id>` is meaningful in the
terminal prompt because the prompt has a command parser. A canvas or
assistant surface needs the original semantic input as well. Store the
source prompt alongside the assistant message, then map widget reruns
back to that prompt.

Good:

```ts
type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  sourcePrompt?: string;
};

if (command.startsWith("rerun ")) {
  onSubmit(message.sourcePrompt || message.text);
}
```

Bad:

```ts
// The canvas does not know what query this execution id represents.
runCommand(`rerun ${executionId}`);
```

Surfaced in round 8. Evidence:
`bridge/outbox/20260509-155138-canvas-widget-rerun-green.result.json`.

## See also

- [Agent orchestration](../architecture/agent_orchestration.md)
- [Widgets in output](../gui/widgets.md)
- [Catalog UX](../gui/catalog-ux.md)
- [Travel agent tutorial](../tutorials/07-travel-agent-with-widgets.md)
- [`mlflowio/chatui`](https://github.com/mlflowio/chatui), the
  upstream widget pattern source tracked read-only in ai-meta at
  `references/chatui`
