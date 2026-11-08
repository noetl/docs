# Snowflake ↔ Postgres transfer (quickstart) — current DSL

current DSL:
- Use `kind: transfer` (or tool-specific patterns) inside `step.tool`.
- Handle retry via `task.spec.policy.rules`.
- Store large intermediate payloads reference-first (ResultRef) and load with `kind: artifact`.

## See also
- Transfer tool: `/docs/reference/tools/transfer`
- Snowflake tool: `/docs/reference/tools/snowflake`
- Postgres tool: `/docs/reference/tools/postgres`
