---
title: 'Render widgets from a playbook'
sidebar_label: '06 · Widget Rendering'
sidebar_position: 6
description: 'Build a playbook step that emits a render descriptor, view it in the NoETL terminal-style prompt, and verify that nested widget args survive event projection. About 30 minutes.'
---

# Render widgets from a playbook

This tutorial shows how to make a playbook produce a structured GUI
output block. The playbook still returns ordinary JSON, but one step
adds `result.render = { type, args }`. When you run
`report <execution_id>` in the NoETL GUI prompt, the prompt renders
that descriptor below the textual report.

The widget descriptor shape comes from
[Widgets in output](../gui/widgets.md). The upstream pattern source,
`mlflowio/chatui`, uses chat/message vocabulary; NoETL renders the
same descriptors inside the terminal-style `NoetlPrompt`.

Estimated time: 30 minutes.

## Prerequisites

- A running NoETL stack with `noetl-server`, `noetl-worker`, and
  `noetl-gui`.
- NoETL `v2.37.2` or newer. That release preserves nested
  `render.args` through the worker event-projection path.
- GUI `v1.8.0` or newer. That release includes the widget renderer
  used by the prompt.
- Completed [Quickstart](./01-quickstart.md), or an equivalent
  local/GKE deployment.

## Step 1 — Create a small widget playbook

Create `widget_render_tutorial.yaml` somewhere in your playbook
workspace:

```yaml
apiVersion: noetl.io/v1
kind: Playbook
metadata:
  name: tutorials/widget_render_tutorial
  path: tutorials/widget_render_tutorial
  version: "0.1.0"
spec:
  workflow:
    - step: render_summary
      tool: python
      code: |
        execution_id = context.get("execution_id", "current execution")
        result = {
          "status": "ready",
          "summary": "Widget render tutorial payload is ready.",
          "render": {
            "type": "app:column",
            "args": {
              "gap": 12,
              "children": [
                {
                  "type": "app:alert",
                  "args": {
                    "variant": "success",
                    "message": "The playbook emitted a widget render descriptor."
                  }
                },
                {
                  "type": "app:markdown",
                  "args": {
                    "text": "## Widget tutorial\nThis block was rendered from `result.render.args.children`."
                  }
                },
                {
                  "type": "app:button",
                  "args": {
                    "text": "Refresh report",
                    "variant": "primary",
                    "event": {
                      "key": "command",
                      "value": f"report {execution_id}"
                    }
                  }
                }
              ]
            }
          }
        }
```

The important part is the `render` object:

- `type: app:column` selects the column renderer.
- `args.children[]` nests three child widgets.
- The button uses `event.key: command`, so clicking it sends the
  command in `event.value` back through the prompt.

## Step 2 — Register and run it

Register the playbook through the catalog path your environment uses.
For a local tutorial workspace, that usually looks like:

```bash
noetl register widget_render_tutorial.yaml
```

Then run it:

```bash
EXEC_ID=$(noetl run tutorials/widget_render_tutorial \
  --runtime distributed \
  --json | jq -r '.execution_id')

echo "$EXEC_ID"
```

If your environment uses an explicit server URL, add
`--server <gateway-or-noetl-server-url>` to the `noetl` commands.

## Step 3 — Verify the stored execution result

Before opening the GUI, confirm the render descriptor persisted:

```bash
noetl status "$EXEC_ID" --json \
  | jq '.events[]
    | select(.result.context.render? or .result.render?)
    | {
        event_id,
        render: (.result.context.render // .result.render)
      }'
```

Expected shape:

```json
{
  "event_id": "...",
  "render": {
    "type": "app:column",
    "args": {
      "gap": 12,
      "children": [
        { "type": "app:alert", "args": { "variant": "success" } },
        { "type": "app:markdown", "args": { "text": "## Widget tutorial..." } },
        { "type": "app:button", "args": { "event": { "key": "command" } } }
      ]
    }
  }
}
```

If `type` is present but `args.children` is missing, the stack is too
old or the worker projection path is regressed. Upgrade to NoETL
`v2.37.2` or newer and rerun.

## Step 4 — View it in the GUI prompt

Open the NoETL GUI and run:

```text
report <execution_id>
```

Replace `<execution_id>` with the value from Step 2. The prompt should
show the normal textual report first, then a rendered output block
containing:

- a success alert,
- a markdown block,
- a `Refresh report` button.

Clicking the button sends `report <execution_id>` back through the
prompt, the same as typing the command manually.

## Step 5 — Test graceful fallback

Widget descriptors are intentionally data-plane payloads, not catalog
kinds. If the GUI does not recognize a widget type, the prompt should
show an unsupported-widget preview instead of crashing.

Change the render type to an unknown value:

```yaml
          "render": {
            "type": "app:not-yet-supported",
            "args": {
              "hello": "world",
              "nested": { "still": "visible" }
            }
          }
```

Register and run again, then open `report <execution_id>`. Expected:
the prompt displays an unsupported-widget surface with the JSON
payload. That tells you the GUI received the descriptor and degraded
gracefully.

## What you just exercised

- A playbook emitted a render descriptor as ordinary step-result data.
- The worker preserved nested `render.args` through event projection.
- `report <execution_id>` found the descriptor and rendered it in the
  terminal-style prompt.
- A button widget sent a prompt command through `event.key: command`.
- Unknown widget types fell back to a JSON preview instead of breaking
  the prompt.

For the complete widget catalog, see
[Widgets in output](../gui/widgets.md). For how these outputs sit next
to Playbook, MCP, and Credential navigation, see
[Catalog UX](../gui/catalog-ux.md).
