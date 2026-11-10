---
id: playbook_as_mcp_server
title: Playbook-as-MCP-Server
sidebar_label: Playbook-as-MCP-Server
sidebar_position: 4
---

# Playbook-as-MCP-Server

noetl-server can serve playbooks as tools over the
[Model Context Protocol](https://modelcontextprotocol.io), so any MCP client
can list and call them. This is the inverse of `tool: kind: mcp`, which calls
*out* to a remote MCP server.

This page describes noetl-server **3.154.0 and later** (current: 3.156.2) and
the gateway **3.21.0**. Both surfaces are **off by default**. For the
release summary and the related agent and instance surfaces, see
[Interop: MCP, Agents and Instances](./interop.md).

:::warning[Earlier versions of this page]
An earlier version of this page described
`POST /api/mcp/playbook/{path}/jsonrpc`, with one endpoint per playbook,
playbooks exposed unless they set `exposes_as_mcp: false`, and an
`inputSchema` derived from `workload`.

That was the Python server's design. The Rust noetl-server has no such
route. It serves the endpoints below: playbooks are hidden unless they opt
in, and every input schema is written by hand.
:::

## Endpoints

| Route | Mounted when | Serves |
|---|---|---|
| `POST /api/mcp` | `NOETL_MCP_SERVER=true` on the server | One MCP server whose tools are every playbook that sets `metadata.expose.mcp` |
| `POST /api/mcp/{path}` | `NOETL_MCP_SERVER=true` on the server | The MCP server described by the catalog `kind: Mcp` resource at `path`, which must set `spec.serve: true` |
| `POST /noetl/mcp` | `GATEWAY_MCP_PROXY=true` on the gateway | The server's `/api/mcp`, filtered per user |

**Wire shape.** Each request is one JSON-RPC 2.0 message POSTed as JSON
(MCP Streamable HTTP, with no server-initiated stream).
- The server is stateless and issues no `Mcp-Session-Id`.
- Notifications get `202 Accepted`, `GET` gets `405`, and batched requests
  are rejected.
- Request bodies are limited to 1 MiB.
- `initialize` negotiates the protocol revision: `2025-06-18`,
  `2025-03-26` or `2024-11-05`.

**Methods** are `initialize`, `ping`, `tools/list` and `tools/call`.
- Protocol errors use the standard JSON-RPC codes (`-32700`, `-32600`,
  `-32601`, `-32602`, `-32603`).
- A playbook that fails is returned as a tool result with `isError: true`.

## Opting a playbook in

A playbook is never exposed by default. It opts in with `metadata.expose.mcp`:

```yaml
metadata:
  path: examples/tools/findings_in_window
  expose:
    mcp:
      tool: findings_in_window      # MCP tool name, [A-Za-z0-9_.-]{1,64}
      description: Current findings in a time window.   # required
      input_schema:                 # required, written by hand
        type: object
        properties:
          minutes: { type: integer }
      mode: sync                    # sync (default) | async
      timeout: 30                   # sync wait in seconds (default 30, max 120)
      result_step: dispatch         # optional: the step whose result is returned
```

- **`input_schema`** is never derived from `workload`. It is also the
  allowlist for `tools/call` arguments: a key not declared under
  `properties` is rejected unless the schema sets
  `additionalProperties: true`. So a caller cannot override a `workload` key
  the author did not expose.
- **`mode: sync`** starts the execution and waits for it. It returns the
  result of `result_step`, or by default the last step with a result. If the
  execution outlasts `timeout`, the call returns the execution id instead.
- **`mode: async`** returns the execution id at once.
- **Helpers.** Every server also lists `noetl.execution.status`,
  `noetl.execution.result` and `noetl.execution.cancel` for following an
  execution. Playbooks may not claim tool names under `noetl.`.
- **Results are sanitized** before they leave the server.
- **Problems are reported, not hidden.** Two playbooks that claim the same
  tool name are both left out, and so are invalid declarations. Each is
  listed in `tools/list` under `_meta["noetl/not_served"]`.
- **Only the newest catalog version** of a playbook is read for its exposure.

## Grouping tools with a `kind: Mcp` resource

To serve a chosen set of playbooks as their own MCP server, register a
`kind: Mcp` resource with `spec.serve: true`:

```yaml
apiVersion: noetl.io/v2
kind: Mcp
metadata: { name: examples, path: mcp/examples }
spec:
  serve: true
  tools:
    - { name: findings, playbook: examples/tools/findings_in_window }
    - name: neighbors
      playbook: examples/tools/graph_neighbors
      description: Neighbors of a node.
      input_schema: { type: object, properties: { node_id: { type: string } } }
```

It is then served at `POST /api/mcp/mcp/examples`.
- An entry that omits `description` or `input_schema` takes them from the
  referenced playbook's own `expose.mcp`.
- An entry that has neither, and whose playbook has no declaration, is not
  served and is reported under `noetl/not_served`.
- A `kind: Mcp` resource without `spec.serve: true` describes a remote MCP
  server to *call*, and is not served.

## Authorization

The server's `/api/mcp` grants the same capability as `POST /api/execute`
plus `GET /api/executions/{id}`, narrowed to playbooks that opted in. Per-user
filtering is done by the gateway, which owns that policy. With
`GATEWAY_MCP_PROXY=true`:

- **`tools/list`** drops every tool whose playbook the caller may not start.
  Tools that carry no playbook tag are dropped too (fail closed), and the
  `noetl/not_served` diagnostics are shown to admins only.
- **`tools/call`** is refused as an unknown tool unless the caller may start
  the playbook. Its arguments get the same identity binding as any execution
  the gateway starts, and the execution is recorded as the caller's.
- **The `noetl.execution.*` helpers** are owner-only for regular users.

Point external MCP clients at the gateway's `/noetl/mcp`, not at the server.

## Not in scope

- **Server-initiated streams** (SSE progress notifications). Use
  `mode: async` and the `noetl.execution.*` helpers instead.
- **The `resources` and `prompts` protocol methods.** Only tools are served.

## See also

- [Interop: MCP, Agents and Instances](./interop.md): flags, agent
  callbacks, instance discovery.
- [Agent Orchestration](./agent_orchestration.md): how a playbook calls
  another playbook as an agent.
- [MCP Catalog Architecture](./mcp_catalog_architecture.md): `kind: Mcp`
  catalog resources. Note that its lifecycle and discover endpoints describe
  the earlier Python server.
- [Self-Troubleshoot Agent](./self_troubleshoot_agent.md).
