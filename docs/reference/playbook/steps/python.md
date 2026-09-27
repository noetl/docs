# Python in steps — current DSL

current DSL has no `tool: python` step type. Use a Python **tool task** (`kind: python`) inside `step.tool`.

```yaml
- step: transform
  tool:
    - run:
        kind: python
        args:
          items: "{{ workload.items }}"
        code: |
          result = {"count": len(items)}
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

## See also
- standard Python tool: `/docs/reference/tools/python`
- Script loading / script jobs: `/docs/reference/script_execution`
