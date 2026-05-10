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

This is how a step turns its output into a "smart prompt output": a
markdown card, a table, an alert, an embedded image, an iframe to a
CDN-hosted dashboard, an interactive form that posts back into the
prompt, etc.

The upstream widget descriptions in Confluence use "chat" and
"message" language because they were written for a chat surface. In
NoETL, the same `{ type, args }` descriptors render inside the
terminal-style `NoetlPrompt`: the plain execution report stays as
prompt text, and the widget appears as the structured output block
for that command.

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
| `app:markdown` | `{ text: string }` | Markdown renderer for reports and explanations. NoETL currently ships a small dependency-free subset: headings, lists, fenced code, links, **bold**, *italic*, `code`. HTML is escaped. |
| `app:title` | `{ text, size?, color?, boldness?, style? }` | Heading text with inline typography overrides. |
| `app:text` | `{ title, message, titleColor? }` | Labeled message — small bold title above body. |
| `app:horizontalline` | `{}` | Thin `<hr>`. |
| `app:picture` | `{ imageUrl?, imageBase64?, imageType?, maxWidth?, maxHeight?, altText? }` | Image from URL or raw base64. `imageUrl` wins when both sources are present; `imageBase64` is the encoded content without the `data:image/...;base64,` prefix; `imageType` defaults to `jpeg`; max dimensions constrain the prompt block. |
| `app:icon` | `{ name, style?, tooltip? }` | Antd icon resolved by exported component name (for example `"CalendarOutlined"`), with optional inline style and tooltip text. |
| `app:profilepicture` | `{ src?, alt?, size?, rounded?, border? }` | Avatar/profile image with placeholder fallback, square pixel size, optional circle shape, and optional border/background treatment. |
| `app:statusbar` | `{ text, styleKey? }` | Inline status pill. Known style keys include `success`, `error`, `warning`, `info`, `processing`, and `default`; unknown values fall back to neutral styling. |
| `app:alert` | `{ message, variant? }` | Highlighted notice box. Variants match `success`, `error`, `warning`, `info`, `processing`, and `default`; omitted or unknown variants render neutrally. |
| `app:tooltip` | `{ title, placement?, color?, disabled?, iconName?, size?, iconColor?, textColor? }` | Hoverable icon with tooltip. Placement accepts the Antd placement set (`top`, `bottomRight`, `leftTop`, etc.) plus hyphenated equivalents. |
| `app:infotable` | `{ data, fields? }` | Label-value table from a record; keys become human-readable labels, and booleans render as check/cross icons. |
| `app:infogrid` | `{ widgets, border? }` | Responsive two-column grid of nested widgets, useful for grouping related tables, markdown blocks, and status surfaces. |
| `app:grouped_table` | `{ groups: [{ title, data: [[label, value], ...] }, ...] }` | Multiple labeled label-value blocks. |
| `app:table` | `{ size?, data: string[][] }` | Simple two-column or small matrix table. `size` controls compactness; header text is generated but visually hidden for label-value use cases. |
| `app:recordtable` | `{ columns, data, width?, pageSize?, disableHeader?, showNull? }` | Antd Table with sort/filter-capable columns. Rows should include a stable `id` because the underlying table uses it as the React row key. |
| `app:filedisplay` | `{ file: { name, type?, metadata?, url } }` | File card with preview/download behavior. Images can render a preview; other file types render icon + name and link/download action. |

### Layout widgets

| `type` | Shape | Purpose |
|---|---|---|
| `app:row` | `{ children: WidgetContent[], gap?, align?, justify? }` | Horizontal flexbox of nested widgets. `gap` is pixels; `align` controls vertical alignment; `justify` controls horizontal distribution. |
| `app:column` | `{ children: WidgetContent[], gap?, align?, justify? }` | Vertical flexbox of nested widgets. `gap` is pixels; `align` controls horizontal alignment; `justify` controls vertical distribution. |
| `app:container` | `{ padding?, margin?, child? }` | Spacing wrapper around a single child widget. |
| `app:carousel` | `{ carouselWidth?, carouselHeight?, widgets }` | Sliding deck of nested widgets with previous/next controls and a position indicator. Width and height may be fixed pixels or omitted for auto layout. |
| `app:expandable` | `{ isExpand, minimalContent, fullContent }` | Toggle between collapsed and expanded nested widget views. |
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
| `app:button` | `{ text, variant?, buttonType?, colorType?, width?, disabled?, forceLoading?, loadingDelay?, event? }` | `onPressEvent(event.key, event.value)` | Clickable button with Antd-style type/color, optional loading state, and optional prompt event. |
| `app:calendar` | `{ event?, width?, firstDate?, initialDate?, lastDate? }` | `onChangeEvent(event.key, formatted_date)` | Compact date picker with optional lower/upper bounds and preselected date. `event.valueFormat` controls the emitted date string. |
| `app:dropdown` | `{ placeholder?, selectedId?, selectionVariants: [{id, label}, ...] }` | `onDropdownChange("dropdownSelection", id)` | Single select with optional placeholder and preselected option. |
| `app:radio` | `{ title, selectedId?, radioValues: [{id, label}, ...] }` | `onRadioSelect("radioSelection", id)` | Single-select radio group; `title` may be empty when the surrounding prompt text already labels the choice. |
| `app:checkbox` | `{ title, checkboxValues: [{id, label, defaultChecked?}, ...] }` | `onCheckboxChange("checkboxSelection", string[])` | Multi-select group. The event value is the full array of selected option ids after each toggle. |
| `app:input` | `{ title?, placeholder?, onChange?: { key }, disabled? }` | `onInputChange(onChange.key, value)` | Text field. |
| `app:form` | `{ fields: [{ id, title, optional?, validation?, placeholder?, default_value? }, ...], buttons? }` | `onFormSubmit(button.event.key, values)` | Linear validated form. Field ids become keys in the submitted values object; button events can submit, go back, or emit another action. |
| `app:customform` | `{ fields: FieldDef[][], buttons?, buttonPlacement?, revision?, forceResetSignal? }` | `onFormSubmit(button.event.key, values)` | Multi-column form with grid layout, regex validation, explicit button placement, and reset/revision controls. |
| `app:quiz` | `{ questionWidth?, finishText?, questions: [{ questionId, questionText, answers: [{ answerId, label }, ...] }, ...] }` | `onQuizAnswer` per pick + `onFinishQuiz` on completion | Multi-question quiz with answer events per question and a final completion event. |
| `app:draganddrop` | `{ backgroundColor?, icon?, text?, width?, height? }` | `DROP_EVENT("dragAndDrop", JSON.stringify([{ name, type }]))` | File/text drop zone. The emitted payload carries dropped item names and MIME-ish types, not raw file bytes. |

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

For the broader set of design rules learned while building the travel
agent flagship workflow - render-as-tail playbook shape, side-effect
audit, Jinja quoting, pluggable provider constraints, and widget button
event handling - see the
[Playbook authoring guide](../reference/playbook_authoring_guide.md).

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

For image-like widgets, prefer HTTPS `imageUrl` values for stable
shared reports. `imageBase64` is supported for generated artifacts,
but it increases execution document size; keep those payloads small
and include `altText`. The image-message design notes also call out
loading, error, and empty states; in NoETL those states should stay
inside the prompt output block and should not block the textual
execution report from rendering.

## Related references

- [Catalog UX](catalog-ux.md) — kind-aware navigation that pairs with
  widget output.
- [Render widgets from a playbook](../tutorials/06-widget-rendering.md)
  — step-by-step tutorial for emitting `result.render`, checking the
  persisted execution, and viewing it with `report <execution_id>`.
- [Travel agent GUI walkthrough](../tutorials/08-travel-agent-gui-walkthrough.md)
  — screenshot-led walkthrough of prompt widgets, the travel canvas,
  provider pills, and refinement forms.
- [`architecture/agent_orchestration.md`](../architecture/agent_orchestration.md)
  — how step results flow through the event source.
- [`mlflowio/chatui`](https://github.com/mlflowio/chatui) —
  reference repository for the widget pattern; tracked at
  `references/chatui` in the ai-meta repo as read-only.
