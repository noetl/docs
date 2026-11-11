---
id: interop
title: "Interop: MCP, Agents and Instances"
sidebar_label: Interop (MCP, Agents, Instances)
description: How playbooks are served over MCP and as agents, and how NoETL instances register, discover each other and hand off work.
---

# Interop: MCP, Agents and Instances

This page covers how a playbook is called from outside NoETL, and how separate
NoETL instances find each other and pass work between them. It applies to
noetl-server **v3.156.2**, the gateway **v3.21.0**, and the `noetl` CLI
**6.0.0**.

Every server surface on this page is **off by default**. With its flag unset,
a route is not mounted at all, and the server behaves as it did before the
feature existed.

## Release summary

| Change | Where | Release |
|---|---|---|
| `kind: playbook` returns the child's result (`return_result`, `result_step`) on the local runtime | CLI | 5.6.0 |
| The local runtime refuses a playbook with an unsupported tool kind at load time (**breaking change**) | CLI | 6.0.0 |
| `noetl instance`: identity, register, discover, handoff, serve | CLI | 5.7.0 |
| `POST /api/mcp`: playbooks served as MCP tools (`NOETL_MCP_SERVER`) | server | 3.154.0 |
| `/noetl/mcp`: per-user MCP proxy (`GATEWAY_MCP_PROXY`) | gateway | 3.21.0 |
| `/api/agents/*`: playbooks as agents with completion callbacks (`NOETL_AGENT_ENDPOINT`) | server | 3.155.0 |
| `/api/instances/*`: registry, discovery and pull-based handoff (`NOETL_INSTANCE_REGISTRY`) | server | 3.156.0 |
| Embedded ehgraph pinned to `f200516` (Cypher, transactions, the subgraph fix) | server | 3.156.2 |

## Local runtime changes (CLI)

These apply to `noetl run -r local` and `noetl subscribe`. For the full
picture, see [Local Playbook Execution](/docs/cli/local_execution).

- **Sub-playbook results.** A `kind: playbook` step with `return_result: true`
  gets the child's result as its own result, readable as `{{ <step>.result }}`
  and through `vars:`.
  - By default, that is the last child step that produced a result.
  - `result_step: <name>` picks a specific child step. If the child never ran
    that step, the step fails with an error listing the steps that did produce
    results.
  - Without `return_result`, nothing changes: the step has no result.

  These are the same field names and the same default as the distributed
  runtime, so one playbook behaves the same on both.
- **Unsupported tool kinds fail at load (6.0.0).** If any step, including one
  in a sub-playbook or an agent tool playbook, uses a tool kind the local
  runtime cannot execute, the run is refused before any step runs.
  - The error lists each offending step and its kind, and points to
    `--runtime distributed`.
  - Earlier versions printed a warning, skipped the step, and still reported
    success.
  - There is no opt-out. `noop` remains a deliberate no-op.

## Playbooks as MCP tools

**Server.** With `NOETL_MCP_SERVER=true`, noetl-server serves MCP (JSON-RPC 2.0
over Streamable HTTP, stateless) at two kinds of route:

- `POST /api/mcp`: one MCP server whose tools are every playbook that opts in.
- `POST /api/mcp/{path}`: the MCP server described by a catalog `kind: Mcp`
  resource at `path` that sets `spec.serve: true` and `spec.tools`.

**Methods.** The server answers `initialize`, `ping`, `tools/list` and
`tools/call`.
- Notifications get `202 Accepted`, `GET` gets `405`, and batches are
  rejected.
- Every server also lists three helper tools: `noetl.execution.status`,
  `noetl.execution.result` and `noetl.execution.cancel`.

A playbook is never exposed unless it opts in:

```yaml
metadata:
  path: examples/tools/findings_in_window
  expose:
    mcp:
      tool: findings_in_window      # MCP tool name, [A-Za-z0-9_.-]{1,64}
      description: Current findings in a time window.
      input_schema:                 # required, written by hand
        type: object
        properties:
          minutes: { type: integer }
      mode: sync                    # sync (default) | async
      timeout: 30                   # sync wait in seconds (default 30, max 120)
      result_step: dispatch         # optional: the step whose result is returned
```

- **`input_schema` is written by hand, never derived from `workload`.** It is
  also the allowlist for `tools/call` arguments: a key not declared under
  `properties` is rejected unless the schema sets
  `additionalProperties: true`.
- **`mode: sync`** waits for the execution and returns its result, chosen the
  same way as `return_result` / `result_step`. If the execution outlasts the
  timeout, the call returns the execution id instead.
- **`mode: async`** returns the execution id immediately. Use the
  `noetl.execution.*` helpers to follow it.
- **Results are sanitized** before they leave the server.
- **Duplicate tool names** expose neither playbook. Duplicates and invalid
  declarations are reported in `tools/list` under `_meta["noetl/not_served"]`.
- **Only the newest catalog version** of a playbook is read for its exposure.

**Gateway.** With `GATEWAY_MCP_PROXY=true`, the gateway serves `/noetl/mcp`
in front of the server and applies per-user authorization:

- `tools/list` drops every tool whose playbook the caller may not start. Tools
  without a playbook tag are dropped too (fail closed).
- `tools/call` is refused as an unknown tool unless the caller may start that
  playbook. Its arguments get the same identity binding as any execution the
  gateway starts.
- The `noetl.execution.*` helpers are owner-only for regular users.

With the flag unset, `/noetl/mcp` stays on the generic proxy: admins are
forwarded, everyone else gets 403.

## Playbooks as agents (callbacks)

With `NOETL_AGENT_ENDPOINT=true`, a playbook can be called as an agent that
reports back when it finishes. A playbook opts in with `metadata.expose.agent`:

```yaml
metadata:
  expose:
    agent:
      card: { name: ..., description: ..., version: ..., skills: [...] }
      input_schema: { ... }   # hand-written, or borrowed from expose.mcp
      result_step: answer     # optional
```

| Route | Purpose |
|---|---|
| `GET /api/agents`, `GET /api/agents/cards/{path}` | A2A-shaped agent cards |
| `POST /api/agents/send` | `{agent, input, callback_url?, deadline_secs?}` → `202 {task_id, status, callback_token?}`. `task_id` is the execution id |
| `GET /api/agents/tasks/{task_id}` | `submitted` / `working` / `completed` / `failed` / `canceled`, with the sanitized result or error |

**Callbacks.** When `callback_url` is given, the final task is POSTed there
with `Authorization: Bearer <token>`.
- The token is random and single-use, and appears only in the `202` response.
- The callback's origin must be listed in `NOETL_AGENT_CALLBACK_ORIGINS`. With
  the list empty, every callback is refused.
- The origin is checked before the execution starts, so a refused callback
  leaves no orphan run.
- Redirects are not followed. A `4xx` response is final; a `5xx` or transport
  error is retried with backoff.
- At most 256 callbacks can be pending.

Callbacks are held in process memory and do not survive a server restart, so
poll `GET /api/agents/tasks/{task_id}` as the fallback. **TARGET:** durable
callbacks and a gateway `/noetl/agents` route are not built.

## Instance registration and discovery

With `NOETL_INSTANCE_REGISTRY=true`, a control plane keeps a registry of NoETL
instances: a CLI, an edge daemon, or a whole cluster.

**Identity.** Each instance has an ML-DSA-87 key, and its id is the hash of
its public key.
- `noetl instance init` creates the key at `~/.noetl/instance/key.json`, mode
  0600.
- Every request is a signed envelope bound to the route's purpose, the control
  plane's audience (`NOETL_INSTANCE_AUDIENCE`, default `noetl`), a timestamp
  and a nonce. A captured request cannot be replayed or re-aimed at another
  control plane.

**Trust.** The default trust mode is an allowlist, and the allowlist starts
empty.
- With `NOETL_INSTANCE_TRUSTED_IDS` empty, **no instance can register**.
- `NOETL_INSTANCE_TRUST=open` admits any instance with a valid key. It is
  meant for kind clusters and local development only, and logs a warning.

**Connections are outbound only.** An instance never needs inbound
connectivity:

| Route | Purpose |
|---|---|
| `POST /api/instances/register` | Idempotent. Registration is the heartbeat, and the lease follows `NOETL_RUNTIME_TTL_SECS` |
| `POST /api/instances/discover`, `GET /api/runtime/instances` | Find instances by tool kind, pool, site, label, playbook glob, `accepts_tasks` and liveness |
| `POST /api/instances/tasks/submit` | Hand a playbook run to another instance |
| `POST /api/instances/inbox` | The target long-polls for its work |
| `POST /api/instances/tasks/result`, `/tasks/status` | The target posts its result; the submitter polls for it |

**Handoff rules.**
- The server enforces the target's own `accepts_tasks` flag and its offered
  playbook globs.
- Claims are leased and redelivered if a target stops responding. A late
  result from a superseded claim is accepted as stale.
- The submitter gets the result by polling, or by callback to an origin in
  `NOETL_AGENT_CALLBACK_ORIGINS`.
- The registry and the task board are soft state: they live in memory, not
  in the event log.

The CLI side:

```bash
noetl instance init
noetl instance register --server https://control-plane.example --offer 'examples/*'
noetl instance discover --server https://control-plane.example --with-tool-kind duckdb
noetl instance handoff  --server https://control-plane.example \
  --playbook examples/report --pin ./examples/report.yaml --wait 60
noetl instance serve    --server https://control-plane.example \
  --playbook-dir ./playbooks --offer 'examples/*'
```

`serve` registers, heartbeats, long-polls the inbox, and runs each task with
the local runtime against `<playbook-dir>/<path>.yaml`. Before running a task,
it re-checks:
- that the playbook matches the globs it offered;
- the content pin (SHA-256), if the task has one;
- that the path cannot escape the playbook directory.

**The instance graph.** With `NOETL_EHGRAPH_TOPOLOGY_WRITER=true` and the
embedded ehgraph running, the server projects the registry into ehgraph
`noetl-cluster`.
- It writes to namespace `topology` by default
  (`NOETL_EHGRAPH_TOPOLOGY_NAMESPACE`).
- Edge types are `registered_with`, `in_pool`, `can_run`, `knows` and
  `delegated_to`.
- A 15-second sweep soft-deactivates instances whose lease has lapsed.

The graph can then be read through ehgraph's tools or
[Cypher](/docs/getting-started/architecture#ehgraph-topology-graph).

## Flags

Server and gateway flags are strict: only the exact value `true` (or `on`,
where noted) enables a surface. Defaults below are the code defaults.
Deployments set their own values.

| Flag | Component | Default | Effect |
|---|---|---|---|
| `NOETL_MCP_SERVER` | server | unset (off) | Mounts `/api/mcp` |
| `GATEWAY_MCP_PROXY` | gateway | unset (off) | Mounts the per-user `/noetl/mcp` |
| `NOETL_AGENT_ENDPOINT` | server | unset (off) | Mounts `/api/agents/*` |
| `NOETL_AGENT_CALLBACK_ORIGINS` | server | empty | Allowed callback origins. Empty refuses every callback |
| `NOETL_INSTANCE_REGISTRY` | server | unset (off) | Mounts `/api/instances/*` |
| `NOETL_INSTANCE_TRUST` | server | `allowlist` | `open` is for development only |
| `NOETL_INSTANCE_TRUSTED_IDS` | server | empty | Instance ids allowed to register. Empty admits nobody |
| `NOETL_INSTANCE_AUDIENCE` | server | `noetl` | The audience every signed request must name |
| `NOETL_EHGRAPH_TOPOLOGY_WRITER` | server | unset (off) | Projects the registry into ehgraph. Needs `NOETL_EHGRAPH_EMBEDDED=true` |
| `NOETL_TOOL_KIND_MCP`, `NOETL_TOOL_KIND_AGENT` | server | unset (off) | Accept `kind: mcp` / `kind: agent` steps on the distributed runtime |
| `NOETL_DSL_KB` | server | unset (off) | Read-only `/api/dsl/*` (schema, tool kinds, version) and `POST /api/dsl/validate` |
| `GATEWAY_PUBLIC_DSL` | gateway | unset (off; enable with `on`) | Public, read-only DSL KB routes |

## Further reading

These pages go deeper. They are linked here rather than repeated.

| Document | Where it lives | What it covers |
|---|---|---|
| Interop RFC | [noetl/ai-meta `docs/rfc/interop-topology-and-ai-mcp-playbooks.md`](https://github.com/noetl/ai-meta/blob/main/docs/rfc/interop-topology-and-ai-mcp-playbooks.md) | The design: mode interop over a live topology, playbooks as MCP servers and agents |
| Build plan | [noetl/ai-meta `docs/rfc/interop-missing-tools-build-plan.md`](https://github.com/noetl/ai-meta/blob/main/docs/rfc/interop-missing-tools-build-plan.md) | Each item in dependency order, its PRs, and REAL / TARGET status |
| DSL knowledge base (DSL-KB) | [noetl/ai-meta `docs/rfc/dsl-knowledge-base.md`](https://github.com/noetl/ai-meta/blob/main/docs/rfc/dsl-knowledge-base.md) | The playbook schema and tool-kind manifest generated from orchestrate-core, and the `/api/dsl/*` surface |
| runtimes-and-interop | `shastaranch/qnetmon` `docs/demo/runtimes-and-interop.md` (private) | The CLI, daemon and cluster as used by one deployment, and the links between them |
| mcp-and-agents | `shastaranch/qnetmon` `docs/demo/mcp-and-agents.md` (private) | The MCP and agent patterns in that deployment |
| communication-architecture | `shastaranch/qnetmon` `docs/demo/communication-architecture.md` (private) | Every network link in that deployment, current and target |

The three qnetmon pages were last checked on 2026-11-09, before the releases
on this page. Where they mark inbound MCP, the agent endpoint, discovery or
the topology writer as TARGET, the summary above is the current state.

## Sources

Checked against code on 2026-11-10:
- noetl/server `v3.156.2`: `src/handlers/mcp_server.rs`, `src/instances/`,
  `src/ehgraph_embedded.rs`.
- noetl/gateway `v3.21.0`: `src/mcp_proxy.rs`.
- noetl/cli `v6.0.0`: `executor/src/playbook.rs`, `src/playbook_runner.rs`,
  `src/instance/`.
