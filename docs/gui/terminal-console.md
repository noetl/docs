---
title: Terminal Console
description: NoETL GUI prompt commands for catalog discovery, execution, diagnostics, and reports
---

# Terminal Console

The NoETL GUI uses a terminal-style console as the primary navigation surface at the top of the authenticated app. The prompt shows the active runtime context and current view:

```text
noetl@kind:/execution$
```

The context name tells the user which NoETL server or local API is currently in use. In local development, `kind` usually means the GUI is talking directly to the NoETL API running in the local kind cluster.

The console replaces the traditional horizontal menu, but the regular dashboard/page views remain available in the lower view window. Users can navigate through commands, clickable console results, or route-specific page actions.

## Windows

The UI is split into two terminal-like windows:

| Window | Purpose |
|---|---|
| Console window | Navigation, commands, execution launch, reports, and diagnostics. |
| View window | The regular GUI page for catalog, editor, execution observability, credentials, travel, or users. |

Both windows can be hidden and shown. Hiding the console leaves the current view open; hiding the view leaves the console available as a command-only workspace.

## Command Reference

| Command | Description |
|---|---|
| `help` | Show the supported console commands. |
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
| `clear` | Clear the console history. |

## Clickable Results

Console output can include clickable actions. For example:

- `menu` returns clickable view targets.
- `ls` returns view targets plus useful contextual commands.
- `playbooks` returns runnable playbook actions.
- `executions` returns actions to open or report on recent executions.

These actions keep the terminal-like workflow fast while preserving the regular GUI navigation and full page views.

Console output rows can also be closed. Longer outputs expose compact/expanded controls so users can keep only the useful command history visible.

## Navigation Examples

```text
noetl@kind:/execution$ menu
noetl@kind:/execution$ cd editor
noetl@kind:/editor$ open execution
noetl@kind:/execution$ open 612955956145554347
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

Keep this page updated whenever console commands or command semantics change.
