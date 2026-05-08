---
title: Embedding widgets in playbook output
sidebar_label: Widgets in output
sidebar_position: 6
description: 'How a playbook step opts into a rich widget render in the NoETL GUI prompt by emitting result.render = { type, args }, mirroring mlflowio/chatui MessageContent.'
---

# Embedding widgets in playbook output

NoETL playbooks return JSON. By default the GUI prompt renders that
JSON as a compact text summary. A playbook step can opt into a
**rich render** by emitting an extra `render` field on its result —
the GUI's prompt sees the field and dispatches it to the matching
widget renderer alongside the textual summary.

This is how a step turns its output into a "smart message": a
markdown card, a table, an alert, an embedded image, an iframe to a
CDN-hosted dashboard, an interactive form that posts back into the
prompt, etc.

## The contract

A widget is a discriminated-union JSON object:

```json
{
  "type": "app:<kind>",
  "args": { ... kind-specific data ... }
}
```

The shape is adapted **directly** from
[`mlflowio/chatui`](https://github.com/mlflowio/chatui)'s
`MessageContent.tsx` dispatcher (registered read-only at
`references/chatui` in the ai-meta repo). Every kind keeps chatui's
field names and types verbatim, so future widget kinds can be ported
by copying their `App<Kind>` component into
`repos/gui/src/components/widgets/`.

A step opts in by attaching the widget object to its result's
`render` field:

```yaml
- step: extract_envelope
  tool: python
  code: |
    result = {
      "smoke_status": "ok",
      "render": {
        "type": "app:markdown",
        "args": {
          "text": "## Diagnosis\n**Category:** infra\n**Confidence:** 0.86\n",
        },
      },
    }
```

When a user runs `report <execution_id>` in the GUI prompt, the
prompt walks the execution's result and events looking for a
`render` field, then renders the widget below the textual report.

## Widget catalog

### Display widgets (read-only)

| `type` | Shape | Purpose |
|---|---|---|
| `app:markdown` | `{ text: string }` | Markdown renderer (small dependency-free subset: headings, lists, fenced code, links, **bold**, *italic*, `code`). HTML is escaped. |
| `app:title` | `{ text, size?, color?, boldness?, style? }` | Heading text with inline typography overrides. |
| `app:text` | `{ title, message, titleColor? }` | Labeled message — small bold title above body. |
| `app:horizontalline` | `{}` | Thin `<hr>`. |
| `app:picture` | `{ imageUrl?, imageBase64?, imageType?, maxWidth?, maxHeight?, altText? }` | Image from URL or base64 (`imageType` defaults to `jpeg`). |
| `app:icon` | `{ name, style?, tooltip? }` | Antd icon resolved by name (e.g. `"CalendarOutlined"`). |
| `app:profilepicture` | `{ src?, alt?, size?, rounded?, border? }` | Avatar; user glyph fallback when `src` missing. |
| `app:statusbar` | `{ text, styleKey? }` | Inline status pill (`success`/`error`/`warning`/`info`/`processing`). |
| `app:alert` | `{ message, variant? }` | Alert box (`success`/`error`/`warning`/`info`/`processing`). |
| `app:tooltip` | `{ title, placement?, color?, disabled?, iconName?, size?, iconColor?, textColor? }` | Hoverable icon with tooltip. |
| `app:infotable` | `{ data, fields? }` | Label-value table from a record; booleans render as check/cross. |
| `app:infogrid` | `{ widgets, border? }` | Auto-fit grid of nested widgets. |
| `app:grouped_table` | `{ groups: [{ title, data: [[label, value], ...] }, ...] }` | Multiple labeled label-value blocks. |
| `app:table` | `{ size?, data: string[][] }` | Simple table; auto headers `Column1..N` (header hidden). |
| `app:recordtable` | `{ columns, data, width?, pageSize?, disableHeader?, showNull? }` | Antd Table with sort/filter; richer than `app:table`. |
| `app:filedisplay` | `{ file: { name, metadata?, url } }` | File card with download button. |

### Layout widgets

| `type` | Shape | Purpose |
|---|---|---|
| `app:row` | `{ children: WidgetContent[], gap?, align?, justify? }` | Horizontal flexbox of nested widgets. |
| `app:column` | `{ children: WidgetContent[], gap?, align?, justify? }` | Vertical flexbox of nested widgets. |
| `app:container` | `{ padding?, margin?, child? }` | Spacing wrapper around a single child widget. |
| `app:carousel` | `{ carouselWidth?, carouselHeight?, widgets }` | Sliding deck of nested widgets. |
| `app:expandable` | `{ isExpand, minimalContent, fullContent }` | Toggle between two widget views. |
| `app:info_block` | `{ items: [{ title, description }, ...] }` | Accordion of expandable info items. |

### Interactive widgets

Interactive widgets emit a `WidgetMessageEvent`
(`{ event, key, value }`) through the renderer's `onWidgetEvent`
callback. NoetlPrompt wires that callback to dispatch prompt actions:

- `key === "command"` and string `value` → `runCommand(value)`.
- `key === "navigate"` and string `value` → navigate to path.
- Anything else → printed into prompt history as an output line so
  the playbook author can see what their widget emitted.

| `type` | Shape | Emits | Purpose |
|---|---|---|---|
| `app:button` | `{ text, variant?, buttonType?, colorType?, width?, disabled?, forceLoading?, loadingDelay?, event? }` | `onPressEvent(event.key, event.value)` | Clickable button. |
| `app:calendar` | `{ event?, width?, firstDate?, initialDate?, lastDate? }` | `onChangeEvent(event.key, formatted_date)` | Date picker with bounds. |
| `app:dropdown` | `{ placeholder?, selectedId?, selectionVariants: [{id, label}, ...] }` | `onDropdownChange("dropdownSelection", id)` | Single select. |
| `app:radio` | `{ title, selectedId?, radioValues: [{id, label}, ...] }` | `onRadioSelect("radioSelection", id)` | Single-select radio. |
| `app:checkbox` | `{ title, checkboxValues: [{id, label, defaultChecked?}, ...] }` | `onCheckboxChange("checkboxSelection", string[])` | Multi-select. |
| `app:input` | `{ title?, placeholder?, onChange?: { key }, disabled? }` | `onInputChange(onChange.key, value)` | Text field. |
| `app:form` | `{ fields: [{ id, title, optional?, validation?, placeholder?, default_value? }, ...], buttons? }` | `onFormSubmit(button.event.key, values)` | Linear validated form. |
| `app:customform` | `{ fields: FieldDef[][], buttons?, buttonPlacement?, revision?, forceResetSignal? }` | `onFormSubmit(button.event.key, values)` | Multi-column form with grid layout. |
| `app:quiz` | `{ questionWidth?, finishText?, questions: [{ questionId, questionText, answers: [{ answerId, label }, ...] }, ...] }` | `onQuizAnswer` per pick + `onFinishQuiz` on completion | Multi-question quiz. |
| `app:draganddrop` | `{ backgroundColor?, icon?, text?, width?, height? }` | `DROP_EVENT("dragAndDrop", JSON.stringify([{ name, type }]))` | File-upload drop zone. |

### NoETL extensions

These don't exist in chatui but ship in noetl-gui because they're
useful for terminal output and CDN-hosted widget embeds.

| `type` | Shape | Purpose |
|---|---|---|
| `app:code` | `{ source, lang?, caption? }` | `<pre><code>` block; `lang` becomes `data-lang` for a future syntax highlighter. |
| `app:iframe` | `{ url, sandbox?, height?, title? }` | Sandboxed iframe (`allow-scripts allow-same-origin` default, `referrer-policy: no-referrer`). Use only URLs you control. |
| `app:link` | `{ href, label?, description? }` | `<a target="_blank" rel="noopener noreferrer">`. |

## Triggering prompt commands from a widget

Combine `app:button` with the `event.key === "command"` convention to
let a widget invoke a prompt command:

```yaml
result:
  render:
    type: app:column
    args:
      children:
        - type: app:alert
          args: { message: "diagnosis ready", variant: success }
        - type: app:button
          args:
            text: "open execution"
            variant: primary
            event:
              key: command
              value: "report 1234567890"
```

Clicking the button invokes `report 1234567890` in the prompt — same
as if the user typed it.

## Where widgets surface today

Round 2 wires `extractAgentRender` into the `report <execution_id>`
prompt command. So a playbook can emit a widget at any step and the
user surfaces it by running `report` against the execution. Future
sub-passes will also pull `render` into the `mcp status`, `mcp tools`,
`k8s ...`, and generic `call` paths so the widget appears
immediately when the agent returns, without an extra `report` step.

## Security and graceful degradation

The renderer is wrapped in an error boundary. A widget component that
throws falls back to a small "unsupported widget" surface showing the
JSON it received, so the prompt never breaks.

`app:markdown` escapes HTML before formatting. `app:iframe` defaults
to a restrictive sandbox and a no-referrer policy. `app:link` always
opens with `noopener noreferrer`.

A widget kind the GUI doesn't recognize falls through to the
"unsupported widget" preview rather than crashing the prompt — so
playbook authors can experiment with new kinds locally before the
GUI knows about them.

## Related references

- Catalog UX — kind-aware navigation that pairs with widget output
  (round 1 of the AI-OS roadmap; tracked in the ai-meta sync issue
  until that page lands in docs).
- [`architecture/agent_orchestration.md`](../architecture/agent_orchestration.md)
  — how step results flow through the event source.
- [`mlflowio/chatui`](https://github.com/mlflowio/chatui) —
  reference repository for the widget pattern; tracked at
  `references/chatui` in the ai-meta repo as read-only.
