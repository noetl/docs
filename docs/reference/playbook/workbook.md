# Workbook (reusable blocks) — current DSL

`workbook` is **optional**. In current DSL it is reserved for a catalog of named reusable tasks/templates. It is not required for the standard baseline.

standard placeholder shape:

```yaml
workbook:
  tasks:
    fetch_assessments:
      kind: http
      method: GET
      url: "{{ workload.api_url }}/api/v1/assessments"
```

How workbook entries are expanded/invoked is runtime/compiler-defined. Keep workbook entries in the same `kind:` task shape used in `step.tool` so they can be inlined/compiled safely.

## See also
- `documentation/docs/reference/dsl/playbook_structure.md`
