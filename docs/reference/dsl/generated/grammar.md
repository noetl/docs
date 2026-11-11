---
sidebar_position: 2
title: Grammar
description: Every NoETL playbook construct and field, generated from the parser's types.
---

# Grammar

:::info[Generated]
Generated from [noetl/server@acfa53cb76bb](https://github.com/noetl/server/tree/acfa53cb76bb9d3d0bfdc92495240da89e41472e/orchestrate-core/schema) (orchestrate-core 0.1.0). **Do not edit**: change the Rust types and regenerate. Machine-readable copies live on [noetl.ai](https://noetl.ai).
:::

## Playbook

NoETL playbook grammar (noetl.io/v2), generated from the Rust authoring types in noetl-orchestrate-core 0.1.0. Permissive like the parser (unknown keys are not rejected); `tool.kind` is closed to the kinds this server accepts. Semantic rules (a `start` step, unique step names, existing `next` targets) are enforced by the server's validator, not by this schema.

| Field | Type | Required | Description |
|---|---|---|---|
| `apiVersion` | string | yes | API version (noetl.io/v2). |
| `kind` | string | yes | Resource kind (Playbook). |
| `metadata` | [Metadata](#metadata) | yes | Metadata (name, path, labels). |
| `workflow` | list of [Step](#step) | yes | Workflow steps. |
| `keychain` | list of [KeychainDef](#keychaindef) (optional) |  | Keychain definitions for credentials and tokens. |
| `vars` | object |  | Top-level variables (canonical format). |
| `workbook` | list of [WorkbookTask](#workbooktask) (optional) |  | Reusable tasks. |
| `workload` | any |  | Global workflow variables. |

## Step

Workflow step with canonical format control flow. Canonical step structure: - step: name (unique identifier) - desc: description - spec: step behavior (next_mode, timeout, on_error) - when: transition enable guard (evaluated by server on input token) - loop: optional loop wrapper with spec.mode - tool: ordered pipeline (list of labeled tasks) OR single tool shorthand - next: outgoing arcs with optional when conditions for routing

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | string | yes | Step name (unique identifier). |
| `tool` | [ToolDefinition](#tooldefinition) | yes | Tool configuration - single tool or pipeline. |
| `args` | object |  | Input arguments for this step. |
| `desc` | string |  | Step description. |
| `loop` | [Loop](#loop) (optional) |  | Loop configuration with spec.mode. |
| `next` | [NextSpec](#nextspec) (optional) |  | Next step(s) with optional when conditions for routing. |
| `set` | object |  | Step-level `set:` mutations — template expressions rendered against the producing step's completion context, then applied via scope-prefix stripping (`ctx.x` → `x`) exactly like arc-level `set:`.  Mirrors Python's step-level `set:` in `noetl/core/dsl/engine/executor/transitions.py`. |
| `spec` | [StepSpec](#stepspec) (optional) |  | Step behavior configuration. |
| `vars` | object |  | Variables to extract from step result. |
| `when` | string |  | Transition enable guard (canonical format). Jinja2 expression evaluated by server before step runs. |

## ToolDefinition

Tool definition - can be single tool or pipeline.

One of: [ToolSpec](#toolspec) \| list of [PipelineItem](#pipelineitem)

## ToolSpec

Tool specification with tool.kind pattern. All execution-specific fields live under tool.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | [ToolKind](#toolkind) | yes | Tool type. Authored, so flag-gated kinds are refused while their flag is off ([`ToolKindGates`]). |
| `args` | any |  | Default arguments / inputs passed to the tool runtime. The canonical NoETL v10 playbook YAML writes this as `input:` at the step's `tool:` block.  The Rust internal name stays `args` because that's what the noetl-tools registry's `ToolConfig` consumes (PythonTool, ShellTool, etc. expose this to user code as `args` / `globals()` / shell env).  The serde alias means both forms decode into the same field; `input:` is the form playbooks should write, `args:` stays accepted for back-compat with existing fixtures. Without the alias, `input:` is silently dropped by serde, the worker's Python wrapper's `globals().update(args)` gets an empty dict, and any user code referencing the workload by name (e.g. `print(f"hello {message}")`) raises `NameError`.  See noetl/ai-meta#56 for the e2e finding. |
| `auth` | any |  | Authentication configuration. |
| `code` | string |  | Python code (for python tool). |
| `command` | any |  | Command for the tool runtime. Two shapes share this key and the type must accept both, so it is `serde_json::Value` (same treatment as `args` above): - **Scalar string** — shell / db tools (`command: "echo hi"`, `command: "SELECT 1"`).  The db tools accept it via a `#[serde(alias = "command")]` on their `query` field. - **Array of strings** — the `container` tool kind, K8s-Job style (`command: ["/bin/sh", "-c"]`), which the worker's `ContainerConfig.command: Option<Vec<String>>` consumes. Before noetl/ai-meta#81 this was `Option<String>`, which made the `container` tool impossible to execute: an array failed the `ToolSpec` deserialise server-side ("data did not match any variant of untagged enum ToolDefinition"), and a scalar cleared the server only to be rejected by the worker ("expected a sequence").  Carrying the raw `Value` lets the array pass through to the worker unchanged while scalars stay JSON strings for the shell / db consumers. |
| `connection` | string |  | Connection string or credential reference. |
| `eval` | list of [EvalEntry](#evalentry) (optional) |  | Tool-level flow control (canonical format). Evaluated after tool execution. |
| `headers` | map of string (optional) |  | HTTP headers. |
| `libs` | any |  | Libraries/dependencies. |
| `method` | string |  | HTTP method (for http tool). |
| `output_select` | any |  | Output selection strategy (for result externalization). |
| `params` | any |  | Tool params. A raw `Value`, for the same reason `command` above is one. ⚠ This was `Option<HashMap<String, Value>>`, i.e. map-only, and a SEQUENCE of positional SQL parameters therefore failed the untagged `ToolDefinition` enum outright — `data did not match any variant of untagged enum ToolDefinition`, a 400 at `POST /api/execute` with no execution and no clue which field was at fault. Measured 2026-10-07: that rejected **all 53 registered `adiona/v1/*` playbooks**, which bind `$1` positionally. The dispatcher has always wanted an array here. `noetl-tools`' `tools/postgres.rs` declares `pub params: Vec<serde_json::Value>` and binds it positionally; its own tests use `"params": [42]`, and `duckdb.rs` uses `[1, "hello"]`. Only `http.rs` uses a map. So the map-only type contradicted the dispatcher for every SQL tool kind while matching it for exactly one. Carrying the raw `Value` lets both forms pass through unchanged. The server has no other reader of this field — it deserialises and re-serialises it for the worker — so widening it changes nothing else. |
| `query` | string |  | Query/SQL (for database tools). |
| `url` | string |  | URL (for http tool). |

_Other keys are accepted (the parser does not reject unknown keys)._

## PipelineItem

One item in a pipeline.  Untagged so serde tries each variant in declaration order and picks the first that decodes. `Flat` is tried first because the v10 dominant form has a top-level `kind:` field (a required field on `ToolSpec`); the nested label-as-key form has no `kind:` at the top level (the key IS the label), so it cleanly falls through to `Nested`.  The serializer round-trips through the nested form so the wire shape downstream (worker's `task_sequence` consumer) stays unchanged.

One of: [ToolSpec](#toolspec) \| map of [ToolSpec](#toolspec)

## EvalEntry

Eval entry - can be a condition or an else clause.

One of: [EvalCondition](#evalcondition) \| object

## EvalCondition

Eval condition for per-task flow control. Evaluated after each tool execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `do` | string | yes | Action to take: continue, retry, break, jump, fail |
| `attempts` | integer |  | Retry attempts (for do: retry). |
| `backoff` | string |  | Retry backoff strategy: linear or exponential. |
| `delay` | number |  | Retry delay in seconds. |
| `expr` | string |  | Jinja2 expression to evaluate. Access outcome object: outcome.status, outcome.error, outcome.result |
| `set_vars` | object |  | Variables to set (step-scoped). |
| `target` | string |  | Target step (for do: jump). |

## EvalElse

Else clause for eval conditions.

| Field | Type | Required | Description |
|---|---|---|---|
| `do` | string | yes | Action to take. |
| `set_vars` | object |  | Variables to set. |

## Loop

Step-level loop configuration (canonical format).

| Field | Type | Required | Description |
|---|---|---|---|
| `iterator` | string | yes | Variable name for each item. |
| `cursor` | [CursorClaim](#cursorclaim) (optional) |  | Claim block for `mode: cursor` loops. |
| `in` | string |  | Jinja expression for collection to iterate over.  Required for `sequential` / `parallel`; absent for `cursor` (which claims work). |
| `spec` | [LoopSpec](#loopspec) (optional) |  | Loop spec with mode (canonical format). |

## LoopSpec

Loop runtime specification (canonical format).

| Field | Type | Required | Description |
|---|---|---|---|
| `frame` | [FrameSpec](#framespec) (optional) |  | Frame sizing/leasing policy (cursor mode only). |
| `max_in_flight` | integer |  | Maximum concurrent iterations in parallel mode / frames in cursor mode. |
| `mode` | [LoopMode](#loopmode) |  | Execution mode: sequential, parallel, or cursor. |

## LoopMode

Loop execution mode.

One of: `sequential`, `parallel` \| `"cursor"`

## FrameSpec

Frame sizing / leasing policy for a `mode: cursor` loop. Only `max_rows` is load-bearing in the orchestrator-driven port (it caps each claim and is injected as `__frame_max_rows` into the claim render context).  The lease/heartbeat/byte fields are accepted for playbook compatibility with the Python engine; stale-reclaim is handled by the playbook's own claim SQL (its `reclaim_stale` CTE), so they are advisory.

| Field | Type | Required | Description |
|---|---|---|---|
| `heartbeat_seconds` | number |  |  |
| `lease_seconds` | number |  |  |
| `max_bytes` | integer |  |  |
| `max_rows` | integer |  | Max rows claimed per frame (the claim SQL's `LIMIT {{ __frame_max_rows }}`). |
| `max_seconds` | number |  |  |
| `process` | string |  | `row` (default) binds `iter.<name>` to one row; `frame` is reserved. |
| `row_concurrency` | integer |  | Rows of one frame to dispatch concurrently (1 = sequential within frame). |

## CursorClaim

The claim block of a `mode: cursor` loop — a SQL tool that atomically leases a frame of work rows and returns them (its `RETURNING` columns become the per-row `iter.<iterator>` object).

| Field | Type | Required | Description |
|---|---|---|---|
| `claim` | string | yes | The claim SQL (atomic lease, e.g. `... FOR UPDATE SKIP LOCKED ... RETURNING ...`). |
| `auth` | string |  | Credential alias for the claim tool. |
| `kind` | string |  | Tool kind running the claim (default `postgres`). |

## NextSpec

Next step specification - supports multiple formats for compatibility. **Variant order is load-bearing.** `#[serde(untagged)]` tries variants top to bottom, and serde deserializes a YAML *sequence* into a struct positionally — so if `Router` (a struct) came first it would greedily eat the list form `next: [{step: x}]` into a `NextRouter` with `spec` taken from element 0 and `arcs` defaulting to `[]`, silently dropping every target (and defeating the unknown-step validation in `validate_next_refs`). The sequence-shaped variants are therefore declared before the struct `Router`, which is reached only for the canonical map form `{ spec, arcs }`.

One of: list of [CanonicalNextTarget](#canonicalnexttarget) \| list of string \| string \| [NextRouter](#nextrouter)

## NextRouter

Canonical v10 next router format with spec and arcs.

| Field | Type | Required | Description |
|---|---|---|---|
| `arcs` | list of [NextArc](#nextarc) |  | List of arcs (outgoing transitions). |
| `spec` | [NextRouterSpec](#nextrouterspec) (optional) |  | Router specification (mode: exclusive/inclusive). |

## NextRouterSpec

Next router spec for v10 format.

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | Routing mode: exclusive (first match) or inclusive (all matches). |

## NextArc

Arc specification for v10 next router format. Canonical format: next.arcs[].when for conditional routing (Petri-net arcs).

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | string | yes | Target step name. |
| `set` | object |  | Arc-level variable mutations to apply to execution context before dispatching the downstream step.  Mirrors Python's `set:` on arcs. Scope-prefixed keys (`ctx.x`, `iter.x`, `step.x`) are stripped to the bare key; bare keys and unknown-scope dotted keys are written as-is.  Values are Jinja2 templates rendered against the producing step's completion context before being applied. YAML key: `set:`.  The legacy `args:` key is rejected by the Python reference parser and is NOT supported here. |
| `when` | string |  | Transition guard expression (Jinja2). Evaluated by server after step completion. |

## CanonicalNextTarget

Legacy target for transition (deprecated, use NextArc).

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | string | yes | Target step name. |
| `args` | object |  | Arguments to pass to target step. |
| `when` | string |  | Transition guard expression (Jinja2). |

## StepSpec

Step-level behavior configuration.

| Field | Type | Required | Description |
|---|---|---|---|
| `next_mode` | string |  | Next evaluation mode: exclusive (first match) or inclusive (all matches). |
| `on_error` | string |  | Error handling: fail, continue, or retry. |
| `timeout` | string |  | Step timeout (e.g., "30s", "5m"). |

## Metadata

Playbook metadata.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Playbook name (required). |
| `description` | string |  | Description. |
| `labels` | map of string (optional) |  | Labels for filtering. |
| `path` | string |  | Resource path. |

_Other keys are accepted (the parser does not reject unknown keys)._

## KeychainDef

Keychain entry for credential/token definitions.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Keychain entry name. |
| `allowed_regions` | list of string |  | Secrets Wallet Phase 6c — extra regions (besides the entry's own `region`) from which resolution is allowed when `residency` is `strict` or `advisory`.  Empty by default. |
| `auth` | string |  | Credential alias used to authenticate to `provider` (e.g. a service account). On a provider that authenticates by ambient identity (GCP Workload Identity), this is unused. |
| `auto_renew` | boolean |  | Auto-renew flag. |
| `credential` | string |  | Credential reference. |
| `map` | map of string (optional) |  | Output-key → secret-reference map. Each value is a secret-path template (rendered against the workload at resolution time); the resolved entry is the object `{ <key>: <secret-value>, ... }` — the "auth object as a map" shape. Absent for single-value entries. |
| `no_broker_fallback` | boolean |  | Secrets Wallet Phase 6e — opt-out for the cross-region broker fallback.  When `true`, a strict-mode residency denial bubbles up as `ResidencyViolation` even if a broker is configured for the entry's region — used for credentials whose policy says "this data physically cannot leave its home region, full stop." Default `false` (broker fallback honoured when registered). |
| `provider` | string |  | Secret-source backend that resolves this entry: `gcp` (Google Secret Manager), `aws`, `azure`, `vault`, `k8s`. When set, the server-side keychain resolver fetches the value(s) from this provider on a cache miss (Secrets Wallet Phase 3b). `None` means the entry is supplied by other means (pre-registered credential, minted token). |
| `region` | string |  | Secrets Wallet Phase 6a — home region of this secret (e.g. `us-east-1`, `europe-west4`).  When set, the resolver passes it to the chosen [`crate::secrets::SecretProvider`]: AWS uses it as the regional endpoint host; Azure / Vault use it for vault / cluster routing; GCP uses it as part of the resource id.  `None` falls back to the server's `NOETL_SERVER_REGION` env.  Per `agents/rules/safety.md`, the region is a routing hint, not a secret — public-safe. |
| `residency` | [Residency](#residency) |  | Secrets Wallet Phase 6c — residency policy.  Controls whether a server in a different region than this entry's `region` is allowed to resolve it.  See [`crate::secrets::residency::Residency`]. |
| `scope` | string |  | Scope type. |
| `token_type` | string |  | Token type. |

_Other keys are accepted (the parser does not reject unknown keys)._

## Residency

Residency policy for a [`KeychainDef`] — part of the playbook model, so it lives in the core with the rest of the types (noetl/ai-meta#108).  The server's `secrets::residency` module re-exports this enum and holds the region-check *logic* (which needs server-only deps); the enum itself is pure data.

One of: `"none"` \| `"advisory"` \| `"strict"`

## WorkbookTask

Reusable task definition in workbook.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Task name. |
| `tool` | [ToolSpec](#toolspec) | yes | Tool configuration. |
| `sink` | any |  | Optional sink configuration. |

## ToolKind

Supported tool kinds.

One of: `http`, `postgres`, `duckdb`, `ducklake`, `python`, `workbook`, `playbook`, `playbooks`, `secrets`, `iterator`, `container`, `script`, `snowflake`, `transfer`, `snowflake_transfer`, `gcs`, `gateway`, `nats`, `shell`, `artifact`, `noop`, `task_sequence`, `rhai` \| `"subscription"` \| `"wasm"`
