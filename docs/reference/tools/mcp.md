---
sidebar_position: 11
title: MCP Tool
description: Call Model Context Protocol servers from NoETL playbook executions
---

# MCP Tool

`kind: mcp` lets a NoETL worker call a Model Context Protocol server from inside a playbook execution. This keeps MCP activity in the normal NoETL audit path: the user or scheduler starts a playbook, the server issues a command, the worker calls the MCP server, and the result is recorded in `noetl.event`, `noetl.command`, and the `noetl.execution` projection.

The GUI terminal should use this pattern for operational commands. It should launch an agent playbook and render the resulting execution, rather than calling MCP servers directly from the browser.

## Basic Tool Call

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: kubernetes_runtime_agent
  path: automation/agents/kubernetes/runtime
  agent: true
  capabilities:
    - kubernetes-observability
    - mcp:kubernetes

workload:
  endpoint: "http://kubernetes-mcp-server.mcp.svc.cluster.local:8080/mcp"
  method: tools/call
  tool: pods_list_in_namespace
  arguments:
    namespace: noetl

workflow:
  - step: call_mcp
    tool:
      kind: mcp
      server: kubernetes
      endpoint: "{{ workload.endpoint }}"
      method: "{{ workload.method }}"
      tool: "{{ workload.tool }}"
      arguments: "{{ workload.arguments }}"
```

## Fields

| Field | Description |
|---|---|
| `server` | Logical MCP server name. Used for reporting and environment fallback lookup. |
| `endpoint` | MCP server HTTP endpoint. If omitted, the worker checks `NOETL_MCP_<SERVER>_URL`, then `NOETL_MCP_URL`. |
| `method` | MCP method. Supported first-class methods are `health`, `tools/list`, and `tools/call`. |
| `tool` | MCP tool name for `tools/call`. |
| `arguments` | JSON object passed as MCP tool arguments. |
| `timeout_seconds` | Request timeout for the MCP operation. Defaults to 60 seconds. |

## Returned Shape

The tool returns an object like:

```json
{
  "status": "ok",
  "server": "kubernetes",
  "endpoint": "http://kubernetes-mcp-server.mcp.svc.cluster.local:8080/mcp",
  "method": "tools/call",
  "tool": "pods_list_in_namespace",
  "arguments": { "namespace": "noetl" },
  "text": "NAMESPACE APIVERSION KIND NAME READY STATUS ...",
  "result": {}
}
```

`text` is extracted from MCP text content when present. `result` keeps the raw MCP result object for follow-up steps and reports.

## Operational Model

For runtime observability, prefer a small agent playbook per operational domain:

- `automation/agents/kubernetes/runtime` for Kubernetes read-only operations.
- Future agent playbooks for databases, queues, storage, or cloud services.

The GUI terminal can map commands such as `k8s pods noetl` to a playbook invocation:

```json
{
  "path": "automation/agents/kubernetes/runtime",
  "workload": {
    "method": "tools/call",
    "tool": "pods_list_in_namespace",
    "arguments": { "namespace": "noetl" }
  },
  "resource_kind": "agent"
}
```

This makes each terminal action a NoETL execution process with status, events, rerun support, and reports.

## Catalog Registration

Agent playbooks should still use `kind: Playbook` inside YAML so the DSL parser can execute them, but they can be registered in the catalog with resource kind `agent`:

```json
{
  "content": "apiVersion: noetl.io/v2\nkind: Playbook\nmetadata:\n  name: kubernetes_runtime_agent\n  path: automation/agents/kubernetes/runtime\n  agent: true\n...",
  "resource_type": "agent"
}
```

The catalog stores that entry as `noetl.catalog.kind = 'agent'`. The execution API treats `playbook` and `agent` as executable resource kinds, while `mcp` and `memory` describe supporting resources that are invoked through agent playbooks.
