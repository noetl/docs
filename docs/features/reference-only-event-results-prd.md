---
title: "PRD: Reference-Only Event Results and Worker-Owned Data Plane"
description: "Refactor NoETL runtime so event.result stores status and references only, while workers persist full payloads directly to result storage."
sidebar_position: 60
---

# PRD: Reference-Only Event Results and Worker-Owned Data Plane

## 1. Context

Tracking issue: `AHM-4124`  
Trigger: Final Jira comment (`focusedCommentId=48137`) and production runtime pressure caused by oversized event payloads.

Current pain:
- Large tool outputs are still flowing through worker -> server API -> `event.result`.
- This bloats the event table, increases serialization/deserialization overhead, and drives memory pressure in server/worker paths.
- Status queries should evaluate execution state, not transport full payload bodies.

## 2. Problem Statement

NoETL control-plane events are mixing two concerns:
- **Control-plane state** (success/failure/routing metadata).
- **Data-plane payloads** (large result bodies).

This coupling causes:
- DB bloat in `event.result`.
- Slow execution/status reads.
- Increased OOM risk under heavy playbooks.
- Tight coupling between worker progress and server payload handling.

## 3. Product Goal

Make NoETL runtime strictly **reference-only** for the worker/server contract:
- `event.result` stores control-plane information only:
  - status / error envelope
  - context fields required for conditional logic
  - reference pointers to full payload
- Full payload is persisted directly by worker to result storage.
- Server API handles state transitions and references, not bulk data transport.

## 4. Non-Goals

- No redesign of playbook DSL semantics.
- No change to credential/keychain storage model.
- No change to user-facing success/failure semantics.

## 5. Success Criteria

Functional:
- No new large payload blobs are written into `event.result`.
- Conditional expressions continue working using context fields and references.
- Worker can retrieve prior step outputs by resolving references (not via embedded payload).

Performance/SRE:
- Reduce average `event.result` byte size by >= 90% for heavy executions.
- Reduce status API payload and query cost for high-volume executions.
- Eliminate payload-induced server OOM scenarios attributable to event-result body inflation.

## 6. User Stories

1. As an operator, I can query execution status quickly without loading large tool bodies.
2. As a playbook author, I can use `when` expressions with context fields exactly as today.
3. As a runtime worker, I can persist/reload full result data via references across retries, loops, and pagination.
4. As a security reviewer, I can confirm references contain no raw credentials or secrets.

## 7. Requirements

### 7.1 Control-plane event contract

`event.result` is an object that carries `reference` and `context` attributes for runtime control-plane behavior.

`event.result` must contain:
- `status`: `ok|error|skipped|break|retry|...`
- `error`: normalized error envelope (if present)
- `reference` (optional): reference object or array of references (manifest), present only when data is persisted by a storage tool
- `context` (optional): size-limited scalar/object fields used by routing and templates
- `meta`: bytes/hash/content-type/store/scope

`event.result` must **not** contain output data at all, regardless of size. It is reference-only.

### 7.2 Worker-owned persistence

Worker must:
- Pass tool output between tool items inside the same step pipeline.
- If a downstream storage tool is defined (for example Postgres), persist output there and build `reference` from that storage location.
- If no storage tool is defined, omit output data entirely and emit execution status only.
- Build/update `context` from actual result data on worker side before event emission.
- Emit only control-plane metadata in completion events: status + optional `reference` + optional `context`.
- Persist-before-emit: worker must not emit `reference` until storage write succeeds.
- Resolve references explicitly when downstream task needs full body.
- Keep task-result pointers **latest-only** inside `tool: []` execution scope:
  - key is task label; if omitted, key is positional task index key (`task_<index>`)
  - value is the latest envelope (`status` + optional `reference` + optional `context`) for that key
  - repeated execution via `goto`/`jump`/retry overwrites the same key
  - `_prev` always points to the latest executed task envelope
  - pointer scope is local to that step pipeline only; cross-step sharing requires explicit context assignment.
- Recovery contract for restart-before-persist / missing reference:
  - if data is not persisted yet, runtime treats output as uncommitted
  - downstream access failure must surface `error.code=REFERENCE_NOT_AVAILABLE`
  - policy may replay by `jump` back to producer task (including `to: previous` in task sequence scope) to regenerate and persist again.

### 7.3 Server responsibilities

Server must:
- Accept and persist only reference-only events; reject event payloads that include output data.
- Use context fields for state transitions and `when` evaluation context.
- Return only state + optional reference/context in execution/status APIs; never hydrate output payload bodies on status paths.

### 7.4 Reference guarantees

Every stored reference must include:
- `type` (required): `relational|nats|object_store`
- `auth_reference` (optional): reference to auth/keychain record ID used to access the data location
- relational reference fields when `type=relational`: `db_url`, `schema`, `table`, `record_id` (or equivalent key fields)
- NATS reference fields when `type=nats`: subject/bucket + key/stream locator, and payload size must be `< 1MB`
- object store reference fields when `type=object_store`: direct object URL
- integrity metadata (`bytes`, `sha256`, `content_type`, `compression`)
- ttl/scope policy: for `nats` and `object_store`, TTL should be explicitly configurable; if omitted, use storage default/unlimited behavior. No TTL policy is required for relational references.

### 7.5 Security and compliance

- No credentials/tokens in context fields.
- `auth_reference` may point to credential/keychain records by ID only (never inline secrets).
- Preserve existing auth controls for resolved data access.

## 8. Target Architecture

### 8.1 Data-plane vs control-plane split

- Control-plane: server, execution state machine, event ingestion, routing metadata.
- Data-plane: worker result storage and retrieval via reference resolver.

### 8.2 Write path (target)

1. Task runs in worker.
2. If the step pipeline includes a storage tool (for example Postgres), worker stores output there and constructs `reference` (db/schema/table/record details).
3. If no storage tool exists in the pipeline, worker omits output payload and keeps only execution status (and optional context).
4. Worker updates in-step latest pointer map by task label/index; any repeated task execution replaces prior pointer for that key.
5. Worker emits event with status + optional `reference` + optional `context`.
6. Server persists compact event and updates projections.
7. If worker crashes before step 5, no committed reference is assumed; replay policy jumps back to producer and re-fetches/re-stores data.

### 8.3 Read path (target)

- Status APIs return compact state + reference/context values.
- Full payload retrieval requires explicit resolve call/tool using `reference`.

## 9. Schema and API Changes

### 9.1 Event payload schema (versioned)

Introduce `result_schema_version: 2` with strict shape validation.

Cutover policy:
- Worker/server communication is v2-only after rollout gate.
- No dual-read compatibility mode for legacy large-payload event contracts.
- Existing legacy heavy rows are removed from the event table during migration.

### 9.2 Reference indexing policy

- No dedicated reference projection table is required.
- Event table is the source for reference lookup and resolver/index operations.
- Add/confirm event-table indexes on execution id + step/task keys + event timestamp/type as needed.

### 9.3 API behavior

- `status`/execution endpoints must not hydrate full data bodies.
- Add/standardize resolver endpoint/tool contract for `reference` retrieval.

## 10. Migration Strategy

Phase 0: Prep
- Add telemetry for `event.result` byte size distributions and payload-in-event violations.

Phase 1: Hard cutover to reference-only v2
- Deploy worker and server together with v2-only contract.
- Server status endpoints ignore/avoid full payload fields.
- Expressions consume context/reference-aware state only.

Phase 2: Legacy data purge
- Delete legacy heavy rows from `event` table that contain inline payload bodies not needed for control-plane state.
- Keep only compact event rows required for current execution/state tracking and audit policy.

Phase 3: Enforcement
- Hard-reject oversized/noncompliant inline payload events at ingest.
- Enable alerting on any contract violations.

## 11. Acceptance Criteria

- Heavy playbook run completes with no large payloads in `event.result`.
- Loop/pagination/retry flows remain correct when only references are propagated.
- Execution status latency and memory profile improve versus baseline.
- No credential leaks detected in event rows or references.

## 12. Test Plan

Unit:
- Reference envelope schema validation.
- Context-field construction and size limits.

Integration:
- End-to-end heavy playbook with large pages.
- Retry + pagination + loop with reference-only propagation.
- Resolver correctness and auth checks.
- Crash/restart between tool completion and persist/emit path: verify missing-reference failure is classified as `REFERENCE_NOT_AVAILABLE` and replay via `jump to previous` succeeds.

Load/soak:
- Concurrent executions with large payload generation.
- Measure DB growth, API latency, memory usage, and OOM behavior.

## 13. Risks and Mitigations

- Risk: Broken expressions if context fields are incomplete.
  - Mitigation: context contract tests + migration guardrails.
- Risk: Reference resolution latency.
  - Mitigation: store selection tuning, caching, manifest strategy.
- Risk: Rollout mismatch between worker and server versions.
  - Mitigation: coordinated cutover gate and version precheck before enabling traffic.

## 14. Rollout and Observability

Metrics:
- `event_result_bytes` (p50/p95/p99)
- count of inline payload events over threshold
- resolver latency/error rate
- status API latency + memory
- worker/server OOM and restart rates

Dashboards/alerts:
- SLO alert on payload-in-event violations.
- SLO alert on status latency regression.

## 15. Dependencies

- Runtime event model and result storage standards:
  - `docs/reference/dsl/runtime_results.md`
  - `docs/reference/result_storage.md`
  - `docs/reference/tempref_storage.md`

## 16. Decisions (Resolved)

1. Step-pipeline storage behavior:
- In a `tool` list, output from earlier tool items is passed to later tool items.
- If a storage tool exists (for example Postgres as second item after HTTP), output is stored there and storage location details are sent as `reference` in `event.result`.
- If no storage tool exists, output data is omitted and only execution status is written to `event.result`.

2. Reference lookup model:
- No dedicated reference projection table; event table is sufficient.

3. TTL policy:
- No TTL policy required for relational references.
- For NATS/object-store references, TTL should be parameterized; if not set, use storage-system default/unlimited behavior.

4. Ingest enforcement:
- Server hard-rejects noncompliant inline payload events (no auto-externalize fallback in server ingest path).

5. In-step pointer behavior:
- `tool: []` result addressing is latest-only per task key (label or `task_<index>`).
- No historical pointer chain is kept in step context; history is represented by emitted events.

6. Replay behavior on uncommitted data:
- If worker restarts before persistence/event emission, data is treated as uncommitted.
- Consumer-side missing-reference errors use `REFERENCE_NOT_AVAILABLE` and are replayable via task-sequence `jump` (including `to: previous`).

## 17. Implementation Sequencing (Post-PRD)

1. Define and freeze v2 result envelope contract.
2. Implement worker data-plane writer + reference emitter.
3. Implement server compact ingest + status path hardening.
4. Implement resolver contract.
5. Execute legacy event-row purge plan and retention guardrails.
6. Run heavy-playbook validation and ship progressively.
