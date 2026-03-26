---
sidebar_position: 8
title: Status Transition Matrix
description: Canonical lifecycle ownership, transitions, and testing rules for NoETL execution status
---

# Status Transition Matrix

This document defines the intended state ownership and transition model for NoETL status handling.

Use it for:

- runtime lifecycle development
- execution status API design
- regression testing around premature completion
- code review when status-related changes touch engine, worker, or API layers

---

## Core Rule

Overall execution status must come only from the playbook execution lifecycle layer.

Lower-level events such as `command.completed`, `call.done`, `step.exit`, and `batch.completed` are observability or transport signals. They are not valid evidence that a playbook execution is terminal.

---

## State Layers

| Layer | Scope | Owner | Authoritative storage | Terminal states | Must not decide |
|---|---|---|---|---|---|
| Tool outcome | Single tool invocation | Worker or tool executor | `call.done` or `call.error` payload | `OK`, `ERROR`, `BREAK`, `NOOP` | Playbook execution status |
| Command state | Single distributed command | Server and worker | `command.*` events | `COMPLETED`, `FAILED`, `CANCELLED` | Playbook execution status |
| Step state | Single playbook step | Engine | `ExecutionState.completed_steps`, `step_results`, `current_step`, `step.exit` | `COMPLETED`, `FAILED`, `CASE_HANDLED` | Playbook execution status |
| Workflow state | One workflow | Engine | `ExecutionState.completed`, `ExecutionState.failed`, `workflow.*` lifecycle events | `COMPLETED`, `FAILED` | Command completion semantics |
| Playbook execution state | Overall execution | Engine | `ExecutionState.completed`, `ExecutionState.failed`, `playbook.*` lifecycle events, `execution.cancelled` | `COMPLETED`, `FAILED`, `CANCELLED` | Lower-layer event heuristics |

---

## Authoritative Execution Status Model

The execution status API should expose a single normalized lifecycle state:

- `PENDING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

### Ownership

- If live engine state exists, execution status comes from execution-level state.
- If live engine state does not exist, execution status is reconstructed only from persisted execution lifecycle events:
  - `playbook.completed`
  - `playbook.failed`
  - `execution.cancelled`
- No fallback may infer terminal execution status from:
  - `batch.completed`
  - `command.completed`
  - `call.done`
  - `step.exit`

---

## Transition Matrix

### Playbook Execution

| From | Trigger | To | Owner | Persisted signal |
|---|---|---|---|---|
| `PENDING` | Playbook initialized | `RUNNING` | Engine | `playbook.initialized` |
| `RUNNING` | Engine emits terminal success | `COMPLETED` | Engine | `playbook.completed` |
| `RUNNING` | Engine emits terminal failure | `FAILED` | Engine | `playbook.failed` |
| `RUNNING` | Cancel API or runtime cancel path | `CANCELLED` | Server or engine | `execution.cancelled` |

Rules:

- Terminal playbook states are exactly `COMPLETED`, `FAILED`, and `CANCELLED`.
- Only the execution lifecycle layer may close an execution.

### Workflow

| From | Trigger | To | Owner | Persisted signal |
|---|---|---|---|---|
| `PENDING` | Workflow starts | `RUNNING` | Engine | `workflow.initialized` |
| `RUNNING` | Engine determines all required work is complete | `COMPLETED` | Engine | `workflow.completed` |
| `RUNNING` | Engine determines unrecoverable failure | `FAILED` | Engine | `workflow.failed` |

Rules:

- Workflow lifecycle may inform playbook lifecycle.
- Workflow lifecycle must not be reconstructed from command flushes or worker ack patterns.

### Step

| From | Trigger | To | Owner | Persisted signal |
|---|---|---|---|---|
| `PENDING` | Step scheduled or entered | `RUNNING` | Engine or worker | `step.enter` or command issuance |
| `RUNNING` | Tool succeeds | `COMPLETED` | Engine | `call.done` then `step.exit` |
| `RUNNING` | Tool fails without handled recovery | `FAILED` | Engine | `call.error` then `step.exit` |
| `RUNNING` | Case policy consumes result | `CASE_HANDLED` | Engine or worker | `step.exit` with `CASE_HANDLED` |

Rules:

- Step completion is structural and local.
- Loop and task-sequence steps require special handling so per-iteration events do not close the full execution.

### Command

| From | Trigger | To | Owner | Persisted signal |
|---|---|---|---|---|
| `PENDING` | Command created | `ISSUED` | Server | `command.issued` |
| `ISSUED` | Worker claims | `CLAIMED` | Worker and server | `command.claimed` |
| `CLAIMED` | Worker begins work | `RUNNING` | Worker | `command.started` |
| `RUNNING` | Worker completes | `COMPLETED` | Worker | `command.completed` |
| `RUNNING` | Worker hard fails | `FAILED` | Worker | `command.failed` |
| `ISSUED` or `CLAIMED` | Execution cancelled | `CANCELLED` | Server or reaper | `command.cancelled` |

Rules:

- Command state answers only whether the command finished.
- A fully completed command set does not imply playbook completion unless the engine emits execution lifecycle completion.

### Tool or Task Outcome

| From | Trigger | To | Owner | Signal |
|---|---|---|---|---|
| `PENDING` | Tool invoked | `RUNNING` | Worker | In-flight only |
| `RUNNING` | Tool returns ok result | `OK` | Worker | `call.done` |
| `RUNNING` | Tool returns error | `ERROR` | Worker | `call.error` |
| `RUNNING` | Task-sequence breaks or paginates | `BREAK` or `NOOP` | Worker | Payload only |

Rules:

- Tool outcome feeds routing and step materialization.
- Tool outcome must never be exposed as overall execution status.

---

## Validation Against Current Code

### Canonical execution vocabulary is split

Current code in `noetl/core/status.py` defines canonical statuses including `STARTED`, `RUNNING`, `PAUSED`, `PENDING`, `FAILED`, and `COMPLETED`, but execution APIs also use `CANCELLED`.

Implication:

- `CANCELLED` is already a real terminal execution state.
- It should also be a first-class member of the canonical status utility.

### Step status strings are not normalized

Current code in `noetl/worker/v2_worker_nats.py` emits mixed `step.exit.status` values including `completed`, `COMPLETED`, `failed`, `FAILED`, and `CASE_HANDLED`.

Implication:

- Step observability status is inconsistent.
- That inconsistency is survivable only if step state remains non-authoritative for execution status.

### Engine owns execution completion, but APIs still infer it from lower layers

Current code:

- `noetl/core/dsl/v2/engine.py`
  - sets `state.completed = True` when structural completion is reached
  - emits `workflow.completed` and `playbook.completed`
  - sets `state.failed = True` and emits terminal failure lifecycle events
- `noetl/server/api/execution/endpoint.py`
  - `_infer_execution_completion_from_events()` marks execution `COMPLETED` from lower-layer events
- `noetl/server/api/v2.py`
  - `get_execution_status()` repeats similar inference in both fallback and live-state mode

Implication:

- Execution status is currently being reconstructed from command and step signals.
- That violates the intended ownership model.

### `batch.completed` is being treated as execution-terminal evidence

Current code in `noetl/server/api/execution/endpoint.py` and `noetl/server/api/v2.py` uses `batch.completed` as part of completion inference.

Implication:

- `batch.completed` is a transport or control-plane signal.
- It does not prove that the playbook lifecycle is terminal.

### `command.completed`, `call.done`, and `step.exit` are elevated via `end` heuristics

Current code in `noetl/server/api/execution/endpoint.py` and `noetl/server/api/v2.py` treats several lower-layer events as terminal evidence when attached to `node_name == "end"`.

Implication:

- These events can occur before more work is issued.
- They must not close the execution.

### Status endpoints return execution variables

Current code in `noetl/server/api/v2.py` returns execution variables in both full and compact status responses.

Implication:

- Execution status should report lifecycle state, not execution payload or context.
- Any variable or debug view should be separate from the status API.

---

## Recommended API Contract

`GET /executions/{id}/status` should report only execution lifecycle state and a minimal operational view.

### Minimal Response Model

| Field | Meaning | Source |
|---|---|---|
| `execution_id` | Execution identifier | Execution record |
| `state` | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, or `CANCELLED` | Execution owner |
| `current_step` | Current structural step | `ExecutionState.current_step` |
| `started_at` | Execution start time | Persisted lifecycle |
| `ended_at` | Terminal time if terminal | Persisted lifecycle |
| `terminal_event` | Exact lifecycle event if terminal | Persisted lifecycle |
| `completion_inferred` | Fallback-only signal | API fallback path |

### Strict Rules

- Do not inspect `state.variables` to answer status.
- Do not derive execution state from `command.completed`.
- Do not derive execution state from `step.exit`.
- Do not derive execution state from `call.done`.
- Do not derive execution state from `batch.completed`.
- Only use lifecycle events as persisted truth when reconstructing status without live state.

---

## Development Checklist

When changing status logic:

- confirm the change preserves layer ownership
- confirm no lower-layer event can close an execution
- confirm `CANCELLED` is handled as a first-class execution terminal state
- confirm status endpoints do not expose execution variables
- confirm engine completion is emitted exactly once through lifecycle events

---

## Testing Checklist

### Positive Cases

- execution remains `RUNNING` while commands continue to be issued
- execution becomes `COMPLETED` only after `playbook.completed`
- execution becomes `FAILED` only after `playbook.failed`
- execution becomes `CANCELLED` only after `execution.cancelled`

### Negative Cases

- `command.completed` on the final visible step does not force execution `COMPLETED`
- `step.exit` on a loop or task-sequence iteration does not force execution `COMPLETED`
- `batch.completed` with `pending_count == 0` does not force execution `COMPLETED`
- mixed-case step status values do not change execution status semantics

---

## Maintenance Rule

When status semantics change in `noetl`, update this document in the docs repo and add or refresh an `ai-meta` memory entry that points future development and test work back here.
