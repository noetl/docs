# HTTP tool (playbook authoring) — current DSL

This page previously documented legacy HTTP plugin shapes (`tool: http`, `endpoint`, `case`, `sink`).

current DSL uses HTTP as a **tool task** (`kind: http`) inside `step.tool`, with:
- retry/polling/pagination via `task.spec.policy.rules`
- routing via `step.next.arcs[]`

## See also
- standard HTTP tool: `documentation/docs/reference/tools/http.md`
- Loop iteration: `documentation/docs/reference/iterator_v3.md`
- Retry: `documentation/docs/reference/retry_mechanism.md`
