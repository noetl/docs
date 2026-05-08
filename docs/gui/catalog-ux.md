---
title: Catalog UX (kind-aware navigation, version collapse, cross-field search)
sidebar_label: Catalog UX
sidebar_position: 5
description: How the NoETL GUI catalog presents Playbook, MCP, and Credential resources as first-class navigable entries for terminal-style workflows.
---

# Catalog UX

The catalog is the program registry for NoETL. The GUI catalog view is
therefore not just a list of playbooks: it is the entry point for every
resource kind a user or agent can reference from the terminal-style
prompt.

The current kind-aware surface groups resources into three primary
tabs:

- **Playbook** — executable workflows, including agent and lifecycle
  playbooks.
- **MCP** — Model Context Protocol backends and managed endpoints
  registered in the catalog.
- **Credential** — named credential records referenced by playbooks
  and backend agents.

Each tab keeps the same list shape: path, name, description, tags,
latest version, and last-updated metadata. That consistency lets the
prompt, catalog browser, and execution views use the same identifiers.

## Search and Filters

Catalog search is cross-field. A query can match:

- resource path
- display name
- description text
- tags

The kind tab narrows the result set without changing the search
semantics. For example, `kubernetes` on the MCP tab finds MCP-backed
runtime entries, while the same query on the Playbook tab finds
Kubernetes lifecycle or runtime playbooks.

## Version Collapse

By default, the catalog shows the latest version for each path. This is
the safest view for day-to-day execution because a user normally wants
the runnable current resource, not a historical row.

When a user needs the full audit trail, the detail view exposes the
version history for that path. Older versions remain addressable by
version pin, but the main browser stays compact.

## Navigation Model

Catalog paths behave like breadcrumbs. A path such as:

```text
automation/agents/troubleshoot/diagnose_execution
```

can be read as:

```text
automation > agents > troubleshoot > diagnose_execution
```

Those segments give the GUI natural navigation anchors and give the
prompt a stable token to work with. A user can browse to a resource in
the catalog, then switch back to the prompt and run or inspect that
same path.

## Gateway Routing

The GUI should treat the gateway as the browser-facing API boundary.
Authenticated browser traffic goes through gateway routes, and the
gateway proxies NoETL requests to the server behind the cluster
boundary. That keeps Auth0 session validation, NATS K/V session cache
checks, request IDs, and NoETL execution calls on one consistent path.

For custom frontends, see [Build Custom UI with Gateway](custom-ui-gateway.md).

## How This Pairs With Widget Output

Catalog navigation helps the user find the thing to run. Widget output
helps the user read the result once it runs.

The two surfaces meet in the terminal-style prompt:

1. The user discovers or runs a catalog resource.
2. The execution writes normal text and structured events.
3. A step can attach `render: { type, args }` to its result.
4. The prompt renders that widget below the textual report.

The widget contract is documented in
[Embedding widgets in playbook output](widgets.md).

## Future Direction

The next natural step is tighter prompt integration:

- clicking a catalog row can insert its path into the prompt buffer
- search results can expose contextual actions such as `run`, `open`,
  or `report`
- execution rows can link back to the catalog resource and version that
  produced them

The goal is a catalog that feels like an autocomplete source for the
prompt, not a separate application silo.
