# Storage/save in steps — current DSL

current DSL removes the step-level `sink:` / `save:` blocks.

Storage is a **pattern**:
- use normal tools (postgres/duckdb/gcs/nats/…) to persist data
- return a reference (ResultRef / TempRef) for large payloads
- optionally patch non-secret metadata into `ctx`/`iter` via task policy (`set_ctx` / `set_iter`)

## See also
- Result storage (standard): `/docs/reference/result_storage`
- ResultRef / TempRef: `/docs/reference/tempref_storage`
- Scopes (`workload/ctx/iter`): `/docs/reference/variables`
