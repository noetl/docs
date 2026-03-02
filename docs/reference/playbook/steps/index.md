# Step patterns (overview) — current DSL

current DSL does **not** have step “types” (no `type: http|python|iterator|...`).

Steps are built from:
- `spec` (including `spec.policy.admit` admission)
- optional `loop` (`in` + `iterator` + `loop.spec`)
- `tool` (ordered pipeline of labeled tasks with `kind:`)
- `next` (router: `next.spec` + `next.arcs[]`)

This folder is now a set of pointers to the current DSL pages:
- HTTP: `documentation/docs/reference/tools/http.md`
- Python: `documentation/docs/reference/tools/python.md`
- Postgres: `documentation/docs/reference/tools/postgres.md`
- DuckDB: `documentation/docs/reference/tools/duckdb.md`
- Snowflake: `documentation/docs/reference/tools/snowflake.md`
- Loops: `documentation/docs/reference/iterator_v3.md`
- Retry: `documentation/docs/reference/retry_mechanism.md`
- Storage: `documentation/docs/reference/result_storage.md`
- Step spec: `documentation/docs/reference/dsl/step_spec.md`
