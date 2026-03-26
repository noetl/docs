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
- Server API handles state transitions and refs, not bulk data transport.

## 4. Non-Goals

- No redesign of playbook DSL semantics.
- No change to credential/keychain storage model.
- No change to user-facing success/failure semantics.

## 5. Success Criteria

Functional:
- No new large payload blobs are written into `event.result`.
- Conditional expressions continue working using context fields and references.
- Worker can retrieve prior step outputs by resolving refs (not via embedded payload).

Performance/SRE:
- Reduce average `event.result` byte size by >= 90% for heavy executions.
- Reduce status API payload and query cost for high-volume executions.
- Eliminate payload-induced server OOM scenarios attributable to event-result body inflation.

## 6. User Stories

1. As an operator, I can query execution status quickly without loading large tool bodies.
2. As a playbook author, I can use `when` expressions with context fields exactly as today.
3. As a runtime worker, I can persist/reload full result data via refs across retries, loops, and pagination.
4. As a security reviewer, I can confirm refs contain no raw credentials or secrets.

## 7. Requirements

### 7.1 Control-plane event contract

`event.result` must contain:
- `status`: `ok|error|skipped|break|retry|...`
- `error`: normalized error envelope (if present)
- `ref`: `result_ref` object or array of refs (manifest)
- `context`: size-limited scalar/object fields used by routing and templates
- `meta`: bytes/hash/content-type/store/scope

`event.result` must **not** contain output data at all, regardless of size. It is reference-only.

### 7.2 Worker-owned persistence

Worker must:
- Serialize and store full task outputs directly to configured backend (`auto|postgres|nats_kv|nats_object|gcs`).
- Build/update `context` from actual result data on worker side before event emission.
- Emit only refs + context metadata in completion events.
- Resolve refs explicitly when downstream task needs full body.

### 7.3 Server responsibilities

Server must:
- Accept and persist only reference-only events; reject event payloads that include output data.
- Use context fields for state transitions and `when` evaluation context.
- Return only state + refs + context in execution/status APIs; never hydrate output payload bodies on status paths.

### 7.4 Reference guarantees

Every stored ref must include:
- logical uri (`noetl://...`)
- backend/store descriptor
- integrity metadata (`bytes`, `sha256`, `content_type`, `compression`)
- ttl/scope when applicable

### 7.5 Security and compliance

- No credentials/tokens in context fields.
- Refs may point to credential/keychain records by ID only.
- Preserve existing auth controls for resolved data access.

## 8. Target Architecture

### 8.1 Data-plane vs control-plane split

- Control-plane: server, execution state machine, event ingestion, routing metadata.
- Data-plane: worker result storage and retrieval via ref resolver.

### 8.2 Write path (target)

1. Task runs in worker.
2. Worker writes full body to result store.
3. Worker emits event with status + `result_ref` + `context`.
4. Server persists compact event and updates projections.

### 8.3 Read path (target)

- Status APIs return compact state + refs/context values.
- Full payload retrieval requires explicit resolve call/tool using ref.

## 9. Schema and API Changes

### 9.1 Event payload schema (versioned)

Introduce `result_schema_version: 2` with strict shape validation.

Cutover policy:
- Worker/server communication is v2-only after rollout gate.
- No dual-read compatibility mode for legacy large-payload event contracts.
- Existing legacy heavy rows are removed from the event table during migration.

### 9.2 Optional indexing additions

For performance and observability, add/confirm indexes on:
- execution id + step/task keys
- ref lookup keys (if materialized)
- event timestamp + type

### 9.3 API behavior

- `status`/execution endpoints must not hydrate full data bodies.
- Add/standardize resolver endpoint/tool contract for `result_ref` retrieval.

## 10. Migration Strategy

Phase 0: Prep
- Add telemetry for `event.result` byte size distributions and payload-in-event violations.

Phase 1: Hard cutover to reference-only v2
- Deploy worker and server together with v2-only contract.
- Server status endpoints ignore/avoid full payload fields.
- Expressions consume context/ref-aware state only.

Phase 2: Legacy data purge
- Delete legacy heavy rows from `event` table that contain inline payload bodies not needed for control-plane state.
- Keep only compact event rows required for current execution/state tracking and audit policy.

Phase 3: Enforcement
- Hard-reject oversized/noncompliant inline payload events at ingest.
- Enable alerting on any contract violations.

## 11. Acceptance Criteria

- Heavy playbook run completes with no large payloads in `event.result`.
- Loop/pagination/retry flows remain correct when only refs are propagated.
- Execution status latency and memory profile improve versus baseline.
- No credential leaks detected in event rows or refs.

## 12. Test Plan

Unit:
- Ref envelope schema validation.
- Context-field construction and size limits.

Integration:
- End-to-end heavy playbook with large pages.
- Retry + pagination + loop with ref-only propagation.
- Resolver correctness and auth checks.

Load/soak:
- Concurrent executions with large payload generation.
- Measure DB growth, API latency, memory usage, and OOM behavior.

## 13. Risks and Mitigations

- Risk: Broken expressions if context fields are incomplete.
  - Mitigation: context contract tests + migration guardrails.
- Risk: Ref resolution latency.
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

## 16. Open Questions

1. What default backend policy should `store.kind: auto` use in prod by payload size tier?
2. Do we require a dedicated ref projection table for faster resolver/index lookups?
3. What retention/TTL policy should be default per scope (`step|execution|workflow|permanent`)?

Fixed decision:
- Server hard-rejects noncompliant oversized inline payload events (no auto-externalize fallback in server ingest path).

## 17. Implementation Sequencing (Post-PRD)

1. Define and freeze v2 result envelope contract.
2. Implement worker data-plane writer + ref emitter.
3. Implement server compact ingest + status path hardening.
4. Implement resolver contract.
5. Execute legacy event-row purge plan and retention guardrails.
6. Run heavy-playbook validation and ship progressively.
