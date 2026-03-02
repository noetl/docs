# Postgres in steps — current DSL

current DSL has no `tool: postgres` step type. Use a Postgres **tool task** (`kind: postgres`) inside `step.tool`.

```yaml
- step: write_rows
  tool:
    - insert:
        kind: postgres
        auth: pg_k8s
        command: "INSERT INTO my_table(col) VALUES ('x')"
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' and outcome.pg.code in ['40001','40P01'] }}"
                then: { do: retry, attempts: 5, backoff: exponential, delay: 2 }
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

## See also
- standard Postgres tool: `documentation/docs/reference/tools/postgres.md`
- Retry semantics: `documentation/docs/reference/retry_mechanism.md`
