# HTTP tool (playbook authoring) — current DSL

This page previously documented legacy HTTP plugin shapes (`tool: http`, `endpoint`, `case`, `sink`).

current DSL uses HTTP as a **tool task** (`kind: http`) inside `step.tool`, with:
- retry/polling/pagination via `task.spec.policy.rules`
- routing via `step.next.arcs[]`

## See also
- standard HTTP tool: `/docs/reference/tools/http`
- Loop iteration: `/docs/reference/iterator`
- Retry: `/docs/reference/retry_mechanism`
