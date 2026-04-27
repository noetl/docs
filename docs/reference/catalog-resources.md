---
sidebar_position: 9
title: Catalog Resources
description: Resource kinds stored in the NoETL catalog
---

# Catalog Resources

NoETL stores registered resources in `noetl.catalog`. The catalog row has a `kind` column that references `noetl.resource.name`, so playbooks, agent playbooks, MCP descriptors, credentials, and memory artifacts can share one versioned registry.

## Resource Kinds

| Kind | Executable | Purpose |
|---|---:|---|
| `playbook` | Yes | Standard NoETL workflow definition. |
| `agent` | Yes | Agent-as-playbook entry that can run operational or AI-assisted work. |
| `mcp` | No | Model Context Protocol server or tool provider descriptor. |
| `memory` | No | AI memory, knowledge, or coordination artifact. |
| `credential` | No | Credential or secret reference metadata. |

The `noetl.resource.meta` field records shared metadata such as `executable` and `catalog`. The execution API only starts executable resources. Supporting resources such as `mcp` and `memory` are used by playbooks and agents so every action still has an execution record.

## Agent Playbooks

Agent playbooks keep the DSL document shape:

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: kubernetes_runtime_agent
  path: automation/agents/kubernetes/runtime
  agent: true
```

When registered with `resource_type: "agent"`, the catalog stores the resource as `kind = 'agent'`, while the YAML remains executable as a playbook. This lets the UI and API discover agents separately without creating a second execution model.
