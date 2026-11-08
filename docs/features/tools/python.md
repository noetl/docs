# Python Tool

Run inline Python code inside a playbook step.

## Basic Usage

```yaml
- step: transform
  tool:
    kind: python
    args:
      value: "{{ workload.input }}"
    code: |
      result = {"value": value, "status": "ok"}
```

## Notes

- `input:` is the standard DSL key for tool input; `args:` is the legacy alias.
  Both are accepted.
- Everything the code can see comes from that block. The runtime injects:
  - each key of the input as a **bare global** (so `value` above resolves), and
  - the whole mapping as both `args` and `input_data`, plus `variables`,
    `execution_id` and `step`.
- `workload` is **not** in scope inside `code:` unless you bind it explicitly —
  reference it in the template (`"{{ workload.x }}"`) and bind the result.
- A `def main()` wrapper is optional: plain code setting `result = ...` works,
  and the legacy `main(...)` convention is still supported.
