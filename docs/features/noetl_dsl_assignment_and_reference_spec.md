# NoETL DSL Assignment and Reference Specification

Version: March 2026  
Status: Development Reference for Assignment, Scope, and Reference Handling

## 1. Purpose

This document defines the behavior of `set`, scope mutation, and reference-only value propagation in the NoETL DSL.

The goal is to make assignment and downstream retrieval unambiguous for development, validation, and agentic AI generation.

## 2. Assignment Model

`set` is the only author-facing mutation mechanism.

It is used to:

- write workflow-scoped values into `ctx`
- write step-scoped values into `step`
- write loop-scoped values into `iter`
- transfer references between boundaries
- prepare values for later workflow steps
- update local state between tool items inside a composite tool program

`set` is not nested under `spec`.

Correct:

```yaml
set:
  ctx.page_ref: "{{ output.ref }}"
```

Incorrect:

```yaml
spec:
  set:
    ctx.page_ref: "{{ output.ref }}"
```

## 3. Scope Model

### 3.1 workload

Immutable execution input.

### 3.2 ctx

Workflow-scoped mutable shared state.

### 3.3 step

Current workflow-step local mutable state.

### 3.4 iter

Current loop-iteration local mutable state.

### 3.5 input

Boundary-local input binding.

### 3.6 output

Boundary-local observable result object.

## 4. output Structure

Author-facing `output` is the complete visible result envelope.

Use:

- `output.status`
- `output.data`
- `output.ref`
- `output.error`

Optional kind-specific metadata may be exposed, for example:

- `output.http.status`
- `output.meta`
- `output.context`

`result` is not used in author-facing DSL expressions.

## 5. Assignment Forms

Preferred flat assignment form:

```yaml
set:
  ctx.user_ref: "{{ output.ref }}"
  step.retry_count: "{{ (step.retry_count | int) + 1 }}"
  iter.page: "{{ (iter.page | int) + 1 }}"
```

Nested assignment forms may be normalized by tooling, but flat scoped paths are preferred for validation and generation.

## 6. Assignment Timing

`set` may appear:

- at workflow-step level
- inside tool item policy branches
- after a tool item completes successfully or unsuccessfully
- between tool items in a composite tool program before the next item executes

This allows composite `tool` lists to behave as local state machines while using the same assignment model as step-to-step orchestration.

Example:

```yaml
tool:
  - name: fetch_page
    kind: http
    spec:
      policy:
        rules:
          - else:
              then:
                do: continue
                set:
                  iter.has_more: "{{ output.data.meta.page < output.data.meta.totalPages }}"
                  iter.page_count: "{{ (iter.page_count | int) + 1 }}"

  - name: maybe_continue
    kind: noop
    spec:
      policy:
        rules:
          - when: "{{ iter.has_more | string | lower == 'true' }}"
            then:
              do: jump
              to: fetch_page
```

## 7. Cross-Step Data Propagation

Cross-step data propagation uses `set`, not `next.arcs[].args`.

There are two valid forms:

### 7.1 Step-level publication

Use step-level `set` when the value should be published regardless of which arc is taken.

```yaml
set:
  ctx.stats_ref: "{{ output.ref }}"
  ctx.total_pages: "{{ output.data.total_pages }}"
```

### 7.2 Transition-scoped publication

Use `next.arcs[].set` when the value should be written only if a specific transition is selected.

```yaml
next:
  spec:
    mode: exclusive
  arcs:
    - step: validate
      set:
        ctx.validation_ref: "{{ output.ref }}"
```

### 7.3 Consumer binding

Consumer steps bind published values through `input`.

```yaml
input:
  stats_ref: "{{ ctx.stats_ref }}"
  total_pages: "{{ ctx.total_pages }}"
```

### 7.4 Ordering

If both step-level `set` and `next.arcs[].set` are present, execution order is:

1. the current step or tool program completes
2. step-level `set` is applied
3. `next` arc conditions are evaluated
4. selected arc-level `set` is applied
5. destination step is scheduled

## 8. Reference Assignment Rules

### 8.1 _ref naming rule

Any variable receiving an unresolved reference must end with `_ref`.

Correct:

```yaml
set:
  ctx.records_ref: "{{ output.ref }}"
```

Incorrect:

```yaml
set:
  ctx.records: "{{ output.ref }}"
```

### 8.2 Hydrated data rule

Hydrated payload data must not be stored in `_ref` variables.

Correct:

```yaml
set:
  ctx.records: "{{ output.data }}"
```

Incorrect:

```yaml
set:
  ctx.records_ref: "{{ output.data }}"
```

### 8.3 Validation rules

- `_ref` targets require reference objects
- non-`_ref` targets must not receive unresolved references
- steps must not dereference `*_ref` payload internals directly

## 9. Reference Object Contract

A reference object must explicitly specify how data is retrieved.

Required semantic fields:

- `type` — store type
- `locator` — store-specific lookup details
- `auth_reference` — credential or keychain reference needed to access the data, when required
- `meta` — integrity and metadata fields

Example:

```yaml
output:
  ref:
    type: object_store
    locator:
      bucket: "noetl-results"
      key: "exec/123/page-4.json"
      region: "us-west-1"
    auth_reference: "keychain/results_store"
    meta:
      content_type: "application/json"
      bytes: 1048576
      sha256: "..."
      ttl: "24h"
```

This contract must make the following clear:

- where the data lives
- what channel, protocol, or transport is used to retrieve it
- which credential reference is needed
- how integrity and content metadata are validated

## 10. Reference Resolution

To access full payload content from a reference, a step must call a resolver-capable tool.

Example:

```yaml
- step: resolve_stats
  input:
    stats_ref: "{{ ctx.stats_ref }}"
  tool:
    kind: resolve
    input:
      ref: "{{ input.stats_ref }}"
  set:
    step.stats: "{{ output.data }}"
```

Direct dereference of remote payload content from `ctx.stats_ref` in templates is invalid.

## 11. Parallel Safety

In parallel execution:

- `iter.*` writes are isolated to the current iteration
- `step.*` writes are isolated to the current step execution
- `ctx.*` writes require deterministic merge behavior or explicit platform support

## 12. Authoring Rules for AI Refactoring

AI-generated changes must follow these rules:

1. Replace legacy `args` with `input`
2. Replace legacy `outcome` with `output`
3. Replace legacy payload access through `result` with `output.data`
4. Replace legacy reference access through `result_ref` with `output.ref`
5. Replace `set_ctx` and `set_iter` with `set`
6. Remove `next.arcs[].args` and use step-level `set` or `next.arcs[].set`
7. Preserve `_ref` suffixes for unresolved references
8. Insert explicit resolver steps when downstream payload hydration is required
9. Use `input`, `output`, and `set` consistently inside composite tool programs as well as across workflow steps

## 13. Summary

The required author-facing model is:

- `input` for received values
- `output` for produced values
- `set` for mutation and propagation
- `_ref` suffix for unresolved references
- explicit resolver calls for reference hydration

This model must be enforced consistently so that development and AI-driven refactoring remain unambiguous.
