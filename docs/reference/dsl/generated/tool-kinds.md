---
sidebar_position: 3
title: Tool kinds
description: Every tool.kind the NoETL parser accepts, and which are behind a flag.
---

# Tool kinds

:::info[Generated]
Generated from [noetl/server@5cf0712da626](https://github.com/noetl/server/tree/5cf0712da626a28af9f73f833d48d7c6e5c13140/orchestrate-core/schema) (orchestrate-core 0.1.0). **Do not edit**: change the Rust types and regenerate. Machine-readable copies live on [noetl.ai](https://noetl.ai).
:::

Enabled under default gates. A gated kind is rejected at registration unless its flag is
`true` on that server. **Accepted is not executable**: which kinds a worker can actually run is
reported by workers, not by the parser.

| Kind | Enabled by default | Flag |
|---|---|---|
| `agent` | no | `NOETL_TOOL_KIND_AGENT` |
| `artifact` | yes |  |
| `container` | yes |  |
| `duckdb` | yes |  |
| `ducklake` | yes |  |
| `gateway` | yes |  |
| `gcs` | yes |  |
| `http` | yes |  |
| `iterator` | yes |  |
| `mcp` | no | `NOETL_TOOL_KIND_MCP` |
| `nats` | yes |  |
| `noop` | yes |  |
| `playbook` | yes |  |
| `playbooks` | yes |  |
| `postgres` | yes |  |
| `python` | yes |  |
| `rhai` | yes |  |
| `script` | yes |  |
| `secrets` | yes |  |
| `shell` | yes |  |
| `snowflake` | yes |  |
| `snowflake_transfer` | yes |  |
| `subscription` | yes |  |
| `task_sequence` | yes |  |
| `transfer` | yes |  |
| `wasm` | yes |  |
| `workbook` | yes |  |
