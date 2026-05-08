---
id: playbook_as_mcp_server
title: Playbook-as-MCP-Server
sidebar_label: Playbook-as-MCP-Server
sidebar_position: 4
---

# Playbook-as-MCP-Server

Any registered NoETL playbook can be invoked over the standard
[Model Context Protocol](https://modelcontextprotocol.io) by any
external client (Cursor, Claude Desktop, IDE plugins, peer NoETL
deployments). The endpoint is:

```
POST /api/mcp/playbook/{path:path}/jsonrpc
```

This is the inverse of the existing MCP *client* in
`noetl.tools.mcp` (which calls *out* to a remote MCP server): this
endpoint *answers* the same protocol on top of an arbitrary
playbook. The playbook becomes the tool; its workload becomes the
tool's `inputSchema`; its result envelope becomes MCP content blocks.

For the higher-level framing — how this fits with `tool: kind: mcp`
catalog resources and the lifecycle endpoints — see
[NoETL Catalog-Driven MCP Architecture](./mcp_catalog_architecture.md).
For the GUI entry point into those resources, see
[Catalog UX](../gui/catalog-ux.md).

## Wire shape — JSON-RPC 2.0

The endpoint accepts a single JSON-RPC request per POST. Standard
MCP methods are supported:

| Method        | What it does                                                   |
|---------------|----------------------------------------------------------------|
| `initialize`  | Handshake; returns protocol version + capabilities             |
| `tools/list`  | Returns the single tool this endpoint exposes (the playbook)   |
| `tools/call`  | Dispatches the playbook synchronously, returns content blocks  |
| `ping`        | Returns `{}`; used by clients to keep the connection warm      |

### `initialize`

```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2024-11-05" } }

// Response
{ "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "noetl-playbook-mcp", "version": "1.0" }
  }
}
```

The server echoes the client's `protocolVersion` if present, falling
back to `2024-11-05`.

### `tools/list`

```json
// Request
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }

// Response
{ "jsonrpc": "2.0", "id": 2,
  "result": {
    "tools": [{
      "name": "amadeus_ai_api",
      "description": "Search flights via the Amadeus API ...",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Natural-language flight query" }
        },
        "additionalProperties": true
      }
    }]
  }
}
```

One endpoint = one playbook = one tool. The tool name comes from
`metadata.name` (slashes replaced with dots for filesystem safety),
the description from `metadata.description`, and the `inputSchema`
from the same `infer_ui_schema` helper that drives the GUI's
workload form. **The MCP tool schema and the GUI form stay in sync
— there is no separate source of truth.**

### `tools/call`

```json
// Request
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "amadeus_ai_api",
    "arguments": { "query": "JFK to SFO tomorrow" }
  }
}

// Response (success)
{ "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "Found 3 flights, cheapest $284 ..." }],
    "isError": false,
    "_meta": {
      "noetl_execution_id": "619162855312458297",
      "noetl_path": "api_integration/amadeus_ai_api"
    }
  }
}
```

The `_meta` field is non-standard but explicitly permitted by MCP
spec. It lets clients stitch the call back into the NoETL event log
when they want to.

`tools/call` is **synchronous**: the endpoint dispatches the playbook
via the standard `/api/execute` path, polls
`/api/executions/{id}/status` every 1.5s, and returns when the
execution reaches a terminal status (or after a 90-second ceiling, in
which case the response carries JSON-RPC error code `-32011` with the
execution_id in `error.data` so the client can poll separately).

### Errors

JSON-RPC errors travel in the response body, not the HTTP status —
this is what MCP clients expect. The endpoint returns `200 OK` for
all protocol-level outcomes (including failures) and only uses
non-200 statuses for transport-level problems (malformed body,
unhandled crashes).

| Code     | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `-32601` | Method not found (caller used an unknown method)               |
| `-32602` | Invalid params (e.g. tool name doesn't match the advertised)   |
| `-32603` | Internal server error                                          |
| `-32010` | Playbook ran to completion but reported error                  |
| `-32011` | Playbook timed out (90s ceiling); execution_id in error.data   |
| `-32020` | Auth backend denied access (mirrors HTTP 401/403)              |

Auth errors carry `error.data.http_status` so clients can branch on
the original HTTP-level reason.

## Opt-in via metadata

A playbook is exposed by default. To explicitly *hide* a playbook
from the MCP endpoint, set:

```yaml
metadata:
  name: internal_only_playbook
  exposes_as_mcp: false
```

`exposes_as_mcp` is a typed `Optional[bool]` field on the catalog's
`PlaybookMetadata` Pydantic model — registration validates the shape
at register time, so a typo like `exposes_as_mcp: "yes"` is rejected
with HTTP 422 rather than failing later at MCP-call time. Absent or
`true` means "expose"; explicit `false` means "hide".

## Cursor / Claude Desktop integration

Point an MCP client at the endpoint by adding to its config. For
Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "noetl-amadeus": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {
        "MCP_FETCH_URL": "https://noetl.example.com/api/mcp/playbook/api_integration/amadeus_ai_api/jsonrpc"
      }
    }
  }
}
```

Or with Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "noetl-amadeus": {
      "url": "https://noetl.example.com/api/mcp/playbook/api_integration/amadeus_ai_api/jsonrpc"
    }
  }
}
```

Each tool you want to expose gets its own endpoint entry — one
endpoint per playbook keeps each tool's authorization scope distinct.

## What's not in scope

- **Async tool calls / progress notifications.** `tools/call` is
  synchronous. MCP spec supports streaming progress events but the
  SSE plumbing for parent ↔ child execution events isn't wired
  here yet (tracked separately).
- **Multi-tool endpoints.** One endpoint = one playbook. The catalog
  *is* the multiplexer — clients pick which endpoint to point at,
  and each gets independent auth scope.
- **Resource / prompt protocol methods.** Just tools. We can add
  `resources/list` later if a use case lands; YAGNI for now.

## See also

- [Agent Orchestration](./agent_orchestration.md) — the inverse of
  this: how a NoETL playbook calls another playbook as an agent.
- [MCP Catalog Architecture](./mcp_catalog_architecture.md) — the
  bigger picture for `kind: Mcp` catalog resources, lifecycle
  dispatch, discovery.
- [Widgets in output](../gui/widgets.md) — the GUI-side render
  contract for playbook results that include `render: { type, args }`.
- [Self-Troubleshoot Agent](./self_troubleshoot_agent.md) — a worked
  example of a playbook designed to be exposed via this endpoint.
