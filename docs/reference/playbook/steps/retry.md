# Retry in steps — current DSL

current DSL removes step-level `retry:` blocks.

Retry belongs to **task policy** (`task.spec.policy.rules`) and is evaluated by the worker after a task produces its final `outcome`.

## See also
- Retry mechanism (standard): `/docs/reference/retry_mechanism`
- Step spec: `/docs/reference/dsl/step_spec`
