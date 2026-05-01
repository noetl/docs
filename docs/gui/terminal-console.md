---
title: Terminal Console
description: NoETL GUI prompt commands for catalog discovery, execution, diagnostics, MCP agents, and reports
---

# Terminal Console

The NoETL GUI uses a terminal-style console as the primary navigation surface at the top of the authenticated app. The prompt shows the active runtime context and current workspace:

```text
noetl@kind:/execution$
```

The context name tells the user which NoETL server or local API is currently in use. In local development, `kind` usually means the GUI is talking directly to the NoETL API running in the local kind cluster.

The console replaces the traditional horizontal menu, but the regular dashboard/page views remain available in the lower view window. Users can navigate through commands, clickable console results, or route-specific page actions.

## Windows

The UI is split into two terminal-like windows:

| Window | Purpose |
|---|---|
| Console window | Navigation, commands, execution launch, reports, diagnostics, and MCP-backed agent operations. |
| View window | The regular GUI page for catalog, editor, execution observability, credentials, travel, or users. |

Both windows can be hidden, shown, maximized, and resized. Hiding the console leaves the current view open; hiding the view leaves the console available as a command-only workspace.

## Command Reference

| Command | Description |
|---|---|
| `help` | Show the supported console commands for the current workspace. |
| `context` | Show the active NoETL runtime mode, API base URL, and skip-auth setting. |
| `menu` | Show clickable GUI navigation targets. |
| `ls` | List the current workspace options, including views and contextual commands. |
| `cd <view>` | Navigate to a view such as `catalog`, `editor`, `execution`, `credentials`, `travel`, or `users`. |
| `open <view&#124;execution_id>` | Open a view or execution detail page. |
| `status` | Call the NoETL health endpoint and print the current server status. |
| `playbooks [query]` | List registered playbooks, optionally filtered by path, name, or description. |
| `catalog [query]` | Alias for `playbooks`. |
| `executions [status]` | List recent executions, optionally filtered by status such as `completed`, `failed`, `running`, or `pending`. |
| `ps [status]` | Alias for `executions`. |
| `run <playbook> [payload]` | Start a playbook by catalog ID or path. Payload can be JSON or `--set key=value` pairs. |
| `report <execution_id>` | Load execution detail, print status, result, and event count, then open the execution detail page. |
| `fix <execution_id>` | Run the execution diagnostic API and print the analysis bundle. |
| `diagnose <execution_id>` | Alias for `fix`. |
| `rerun <execution_id> [payload]` | Rerun a previous execution, optionally with replacement workload. |
| `stop <execution_id>` | Request cancellation/stop for a running execution. |
| `cd /mcp` | Navigate to the MCP workspace. |
| `mcp discover` | Discover registered MCP service resources and terminal-visible agent playbooks from the NoETL catalog. |
| `cd /mcp/<name>` | Navigate to a registered MCP workspace, such as `/mcp/kubernetes`. |
| `mcp status` | Launch the selected workspace agent playbook to inspect MCP availability and tool count. |
| `mcp tools` | Launch the selected workspace agent playbook to list exposed MCP tools. |
| `call <tool> [payload]` | Inside `/mcp/<name>`, invoke an MCP tool through the selected workspace agent. Payload can be JSON or `--set key=value` pairs. |
| `k8s pods [namespace]` | Launch the registered Kubernetes runtime agent playbook and list pods. |
| `k8s namespaces` | Launch the registered Kubernetes runtime agent playbook and list namespaces. |
| `k8s events [namespace]` | Launch the registered Kubernetes runtime agent playbook and list Kubernetes events. |
| `k8s deployments [namespace]` | Launch the registered Kubernetes runtime agent playbook and list deployments. |
| `k8s services [namespace]` | Launch the registered Kubernetes runtime agent playbook and list services. |
| `k8s logs <pod> [namespace] [container]` | Launch the registered Kubernetes runtime agent playbook and fetch recent pod logs. |
| `clear` | Clear the console history. |

## Scoped MCP Workspaces

MCP servers are exposed as folder-like workspaces after they are registered in
the NoETL catalog. The GUI does not call MCP servers directly and does not
proxy `/mcp/...` through nginx. It discovers:

- catalog resources with `kind = 'mcp'`
- agent playbooks with `metadata.agent: true` and terminal metadata

If nothing is registered, `/mcp` shows an empty-but-healthy workspace and the
rest of the GUI continues to operate.

The current prompt controls which commands are most natural:

```text
noetl@kind:/mcp$ mcp discover
noetl@kind:/mcp/kubernetes$
```

Inside `/mcp/kubernetes`, Kubernetes commands can be typed without the `k8s` prefix:

| Command | Description |
|---|---|
| `status` | Check the Kubernetes MCP server and report health, agent path, execution ID, and tool count. |
| `tools` | List the MCP tools available from the Kubernetes MCP server. |
| `namespaces` | List namespaces. |
| `pods [namespace]` | List pods across the cluster or in a namespace. |
| `services [namespace]` | List services. |
| `deployments [namespace]` | List deployments. |
| `events [namespace]` | List recent Kubernetes events. |
| `logs <pod> [namespace] [container]` | Fetch recent pod logs. |
| `top [namespace]` | Show pod or node metrics when the cluster metrics API is installed. |

The older global forms, such as `k8s pods noetl`, remain valid from any workspace. The scoped form keeps the terminal closer to a filesystem shell: move to the resource scope first, then run the verbs that are valid for that scope.

Generic MCP scopes, such as `/mcp/gcp`, support the same execution path even
when the GUI does not know provider-specific verbs:

| Command | Description |
|---|---|
| `status` | Run the workspace agent with `tools/list` and show the execution ID plus tool count. |
| `tools` | Print the exposed tool names and descriptions. |
| `call <tool> [payload]` | Invoke a specific MCP tool through the workspace agent. |

Example:

```text
noetl@kind:/mcp$ cd /mcp/gcp
noetl@kind:/mcp/gcp$ tools
noetl@kind:/mcp/gcp$ call list_clusters --set parent=projects/noetl-demo-19700101/locations/-
```

## Clickable Results

Console output can include clickable actions. For example:

- `menu` returns clickable view targets.
- `ls` returns view targets plus useful contextual commands.
- `playbooks` returns runnable playbook actions.
- `executions` returns actions to open or report on recent executions.
- Kubernetes MCP results return actions such as `open <execution_id>`, `report <execution_id>`, `pods`, `namespaces`, `events`, and `services`.

When a command returns structured rows, the terminal can render a compact table instead of plain text. This is useful for Kubernetes resources, catalog entries, execution lists, and future MCP providers.

Console output rows can also be closed. Longer outputs expose compact/expanded controls so users can keep only the useful command history visible.

## Navigation Examples

```text
noetl@kind:/execution$ menu
noetl@kind:/execution$ cd editor
noetl@kind:/editor$ open execution
noetl@kind:/execution$ open 612955956145554347
noetl@kind:/catalog$ cd /mcp/kubernetes
noetl@kind:/mcp/kubernetes$ pods noetl
noetl@kind:/mcp$ cd /mcp/gcp
noetl@kind:/mcp/gcp$ call list_clusters --set parent=projects/noetl-demo-19700101/locations/-
```

## Payloads

For `run` and `rerun`, the console accepts JSON:

```text
noetl@kind:/execution$ run fixtures/playbooks/hello_world {"name":"NoETL"}
```

It also accepts shell-style values:

```text
noetl@kind:/execution$ run fixtures/playbooks/hello_world --set name=NoETL --set limit=10
```

Values that parse as finite numbers are sent as numbers; other values are sent as strings.

## Operating Model

The console is the first GUI shell for NoETL as a distributed business operating system:

- The catalog is the program registry.
- A playbook execution is a process.
- `noetl.event` is the event-sourcing log.
- `noetl.command` is the worker command projection.
- `noetl.execution` is the execution-state projection.
- Kubernetes supplies the distributed runtime substrate.
- The console, CLI, API, and scheduler are user and agent entrypoints into the same workspace.

## MCP and Kubernetes Commands

MCP-backed terminal commands are executed through NoETL playbooks, not direct browser-to-MCP calls. The terminal discovers terminal-visible agents from the NoETL catalog, maps Kubernetes commands to the registered agent playbook, starts a normal NoETL execution with the catalog entry's resource kind, and renders the execution ID plus the final report.

Agent playbooks intended for terminal scopes should declare metadata like:

```yaml
metadata:
  agent: true
  terminal:
    visible: true
    workspace: kubernetes
    scopes:
      - /mcp/kubernetes
  capabilities:
    - mcp:kubernetes
```

For example, this command:

```text
noetl@kind:/mcp/kubernetes$ pods mcp
```

starts a playbook execution equivalent to:

```json
{
  "path": "automation/agents/kubernetes/runtime",
  "resource_kind": "agent",
  "workload": {
    "server": "kubernetes",
    "method": "tools/call",
    "tool": "pods_list_in_namespace",
    "arguments": {
      "namespace": "mcp"
    }
  }
}
```

The resulting MCP request is made by the NoETL worker using `tool.kind: mcp`, so the activity appears in the execution dashboard, event log, command projection, rerun flow, and reports.

For local cluster setup, see [Kubernetes MCP Local Kind Setup](/docs/operations/mcp/kubernetes-local-kind). For playbook syntax, see [MCP Tool](../reference/tools/mcp.md).

Keep this page updated whenever console commands or command semantics change.
