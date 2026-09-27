# Step patterns (overview) — current DSL

current DSL does **not** have step “types” (no `type: http|python|iterator|...`).

Steps are built from:
- `spec` (including `spec.policy.admit` admission)
- optional `loop` (`in` + `iterator` + `loop.spec`)
- `tool` (ordered pipeline of labeled tasks with `kind:`)
- `next` (router: `next.spec` + `next.arcs[]`)

This folder is now a set of pointers to the current DSL pages:
- HTTP: `/docs/reference/tools/http`
- Python: `/docs/reference/tools/python`
- Postgres: `/docs/reference/tools/postgres`
- DuckDB: `/docs/reference/tools/duckdb`
- Snowflake: `/docs/reference/tools/snowflake`
- Loops: `/docs/reference/iterator`
- Retry: `/docs/reference/retry_mechanism`
- Storage: `/docs/reference/result_storage`
- Step spec: `/docs/reference/dsl/step_spec`
