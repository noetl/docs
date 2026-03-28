# NoETL DSL Refactoring Specification

Version: March 2026  
Status: Development Reference for Refactoring and Validation

## 1. Purpose

This document defines the NoETL DSL model to use as the target for refactoring and validation.

It is intended to remove ambiguity for agentic AI development and implementation work across:

- server orchestration
- worker execution
- dynamic execution mode
- playbook composition
- reference-only result handling
- scoped state mutation

This document defines the author-facing DSL surface and the required execution semantics behind it.

## 2. Core Design Principles

### 2.1 Server and worker responsibilities

The server is the sole authority for:

- workflow node admission
- routing between workflow nodes
- dynamic node synthesis
- execution tree ownership
- replay reconstruction from the event log

Workers are pure executors of step tool bodies. Workers do not synthesize workflow nodes and do not mutate the execution graph.

### 2.2 Playbook as template

A playbook is a reusable template for execution. Execution data and runtime state determine how the template is traversed.

### 2.3 Workflow node identity

The workflow list remains a list of named workflow nodes identified by `step`. The `step` concept must remain in the runtime model because it is the schedulable, auditable, replayable graph node.

### 2.4 Tool as executable body

`tool` remains the executable body of a workflow step.

A step may contain:

- a single primitive tool invocation, or
- a composite tool program expressed as an ordered list of tool items

A composite `tool` is still one step-level execution unit.

### 2.5 Unified author-facing data model

The DSL surface uses:

- `input`
- `output`
- `set`

These replace ambiguous combinations such as:

- `args`
- `outcome`
- `result`
- `set_ctx`
- `set_iter`
- `next.arcs[].args`

## 3. Main DSL Concepts

### 3.1 workflow

`workflow` is the orchestration graph seed.

Each item in `workflow` is a workflow node identified by `step`.

### 3.2 step

`step` is the workflow node identity used by the server for:

- admission
- scheduling
- routing
- synthesis
- replay

### 3.3 tool

`tool` is the executable body of the step.

Allowed forms:

#### Single tool form

```yaml
tool:
  kind: http
  input:
    url: "{{ workload.api_url }}"
```

#### Composite tool form

```yaml
tool:
  - name: init_page
    kind: noop
  - name: fetch_page
    kind: http
  - name: paginate
    kind: noop
```

In composite form, tool items may jump, retry, continue, skip, or break according to local policy and runtime state.

### 3.4 input

`input` is the author-facing input binding mechanism.

It may be used at:

- step level
- tool level
- between tool items in a composite tool program

`input` defines the values that a boundary receives.

### 3.5 output

`output` is the author-facing observable result object.

`output` replaces `outcome` and replaces author-facing use of `result`.

Use this structure:

- `output.status`
- `output.data`
- `output.ref`
- `output.error`
- optional kind-specific metadata such as `output.http.status`

`output.data` is the returned payload.  
`output.ref` is the reference to externally stored payload.

### 3.6 set

`set` is the author-facing scoped mutation mechanism.

`set` is a first-class field and must not live under `spec`.

`set` may be used at:

- step level
- tool item level inside a composite tool program
- between tool items, where local state-machine transitions require updated state before another item executes

This allows a composite tool program to behave like a local state machine while still using the same author-facing assignment model everywhere.

### 3.7 spec

`spec` contains execution modifiers and execution policy, such as:

- retry behavior
- timeout
- loop mode
- concurrency
- validation
- storage hints
- policy rules

`spec` does not contain the primary executable body and does not contain `set`.

### 3.8 next

`next` controls routing between workflow steps.

`next` may also contain transition-scoped `set` on individual arcs.

Cross-step data propagation is performed through `set`, using either:

- step-level `set` for values published regardless of which arc is taken
- `next.arcs[].set` for values written only when a specific transition is selected

## 4. Unified Input and Output Semantics

### 4.1 Why input/output are used everywhere

The same concepts are used at every boundary:

- step receives `input`
- tool receives `input`
- tool item may define `input`
- step exposes `output`
- tool item exposes `output`
- playbook call receives `input` and returns `output`

This keeps the DSL consistent for humans and for AI generation.

### 4.2 Tool item chaining inside composite tool programs

In a composite tool program, each tool item may consume `input`, produce `output`, and apply `set` before control moves to another item.

Example:

```yaml
tool:
  - name: init_page
    kind: noop
    set:
      iter.page: 1
      iter.pages_fetched: 0

  - name: fetch_page
    kind: http
    input:
      url: "{{ workload.api_url }}/api/v1/patient-records"
      params:
        patientId: "{{ iter.item }}"
        page: "{{ iter.page }}"
    spec:
      policy:
        rules:
          - when: "{{ output.status == 'error' and output.http.status == 429 }}"
            then: { do: retry, attempts: 30, delay: 1.0 }
          - else:
              then:
                do: continue
                set:
                  iter.has_more: "{{ output.data.meta.page < output.data.meta.totalPages }}"
                  iter.pages_fetched: "{{ (iter.pages_fetched | int) + 1 }}"

  - name: paginate
    kind: noop
    spec:
      policy:
        rules:
          - when: "{{ iter.has_more | string | lower == 'true' }}"
            then:
              do: jump
              to: fetch_page
              set:
                iter.page: "{{ (iter.page | int) + 1 }}"
```

This is valid because `input`, `output`, and `set` are allowed between tool items as part of the same local execution program.

## 5. Scopes

### 5.1 workload

`workload` is immutable execution input.

Use it for external request data and fixed execution parameters.

### 5.2 ctx

`ctx` is workflow-scoped mutable shared state.

Use it for values that must survive across steps.

### 5.3 step

`step` may be used as step-scoped mutable local state.

It exists only for the current workflow step execution.

### 5.4 iter

`iter` is loop-scoped mutable local state.

It is isolated per iteration, especially in parallel mode.

### 5.5 input

`input` is boundary-local bound input.

It exists for the current step, tool, or tool item boundary.

### 5.6 output

`output` is boundary-local observable result.

It exists for the most recently completed executable boundary.

## 6. set Semantics

### 6.1 General rule

`set` writes values into named scopes.

Preferred flat form:

```yaml
set:
  ctx.token_ref: "{{ output.ref }}"
  iter.page: "{{ (iter.page | int) + 1 }}"
  step.request_url: "{{ workload.api_url ~ '/v1/items' }}"
```

### 6.2 Allowed targets

Allowed `set` targets:

- `ctx.*`
- `step.*`
- `iter.*`

Read-only sources include:

- `workload.*`
- `input.*`
- `output.*`

### 6.3 Step-level set vs arc-level set

Use step-level `set` when a value must be published regardless of which next arc is taken.

Example:

```yaml
set:
  ctx.last_ref: "{{ output.ref }}"
  ctx.last_status: "{{ output.status }}"
```

Use `next.arcs[].set` when the value belongs to a specific transition and must only be written if that arc is selected.

Example:

```yaml
next:
  spec:
    mode: exclusive
  arcs:
    - step: validate
      set:
        ctx.validation_ref: "{{ output.ref }}"
```

### 6.4 Ordering

When both step-level and arc-level assignment exist, execution order is:

1. the step or composite tool completes
2. step-level `set` is applied
3. `next` arc conditions are evaluated
4. the selected arc-level `set` is applied
5. the destination step is scheduled

### 6.5 Parallel safety

In parallel loops:

- `iter.*` writes are allowed for the current iteration
- `step.*` writes are allowed for the current step execution
- `ctx.*` writes must follow deterministic merge policy or be explicitly allowed by runtime rules

## 7. Reference-Only Result Model

### 7.1 Rule

Large payloads are not carried inline in step events. They are externalized and represented by `output.ref`.

Downstream full payload access must happen through explicit resolution.

### 7.2 Reference naming convention in set

When assigning a reference, the target variable name must end with `_ref`.

Example:

```yaml
set:
  ctx.patient_records_ref: "{{ output.ref }}"
```

This tells both humans and agents that the value is a locator, not hydrated data.

### 7.3 Hydrated data assignment

If a step wants to store hydrated payload content:

```yaml
set:
  ctx.patient_records: "{{ output.data }}"
```

This is distinct from assigning a reference.

### 7.4 Reference object requirements

A reference object must make retrieval explicit. It must include enough information to determine:

- where the data is stored
- what channel or protocol is needed to retrieve it
- which credential or auth reference is required
- integrity and metadata details

Normalized author-facing shape:

```yaml
output:
  ref:
    type: relational | nats | object_store | blob
    locator: {}
    auth_reference: "keychain/main"
    meta:
      content_type: "application/json"
      bytes: 102400
      sha256: "..."
      ttl: "24h"
```

### 7.5 Resolution rule

A step must not read full business payload fields directly from a reference object.

To access payload content, the step must call a resolver-capable tool.

Example:

```yaml
- step: resolve_records
  input:
    records_ref: "{{ ctx.patient_records_ref }}"
  tool:
    kind: resolve
    input:
      ref: "{{ input.records_ref }}"
  set:
    step.records: "{{ output.data }}"
```

## 8. Workbook and Playbook Reuse

### 8.1 Inline tool reuse vs playbook call

Inline composite `tool` programs are local state machines inside a workflow step.

`kind: playbook` is a separate execution boundary with:

- its own execution instance
- its own scopes
- its own event log
- returned `output` consumed by the caller

Because of that, child playbook calls do not overlap with the caller’s tool item namespace.

### 8.2 Workbook guidance

A workbook-like local reusable unit is only justified if you need an intermediate callable boundary between:

- inline local tool logic
- full child playbook execution

If such a mechanism exists, it must behave as a call boundary, not as macro expansion into the caller’s local item namespace.

## 9. Validation Rules

1. `tool` may be a mapping or a list.
2. `next` performs routing and may carry transition-scoped `set`, but must not carry cross-step payload input.
3. `input`, `output`, and `set` are valid at step level and tool-item level.
4. `set` must not be nested under `spec`.
5. `_ref` targets must receive reference objects.
6. Non-`_ref` targets must not receive unresolved references.
7. `output.data` is the only author-facing payload field; author-facing `result` is disallowed.
8. Author-facing `outcome` is disallowed and replaced by `output`.
9. `args` is disallowed in new authoring and replaced by `input`.

## 10. Migration Summary

Replace:

- `args` -> `input`
- `outcome` -> `output`
- `result` payload access -> `output.data`
- `result_ref` -> `output.ref`
- `set_ctx` / `set_iter` -> `set`
- `next.arcs[].args` -> `next.arcs[].set` or step-level `set`, plus consumer `input`

## 11. Refactoring Goal

The target model is:

- `workflow`
- `step`
- `tool`
- `input`
- `output`
- `set`
- `spec`
- `next`

This model must be used consistently so that AI-generated refactoring and future development have one unambiguous author-facing surface.
