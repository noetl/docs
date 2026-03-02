---
sidebar_position: 3
title: Python Tool 
description: Execute inline Python or external scripts as pipeline tasks 
---

# Python Tool 

The `python` tool runs Python code inside a standard step pipeline (`step.tool`).

Python task modes (implementation-defined, common in NoETL runtimes):
- **Pure code mode:** set a top-level `result = ...` in your code
- **Legacy mode:** define `main(...)` and return a JSON-serializable object

standard reminders:
- Use `workload` for immutable inputs, `ctx` for execution-scoped state, `iter` for iteration-scoped state.
- Use `task.spec.policy.rules` for retry/fail/jump/break/continue.

---

## Basic usage (pure code mode)

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

---

## External scripts (`script` descriptor)

Python also supports the standard `script` descriptor (`uri` + `source`) to load code from GCS/S3/HTTP/filesystem.

```yaml
- run_external:
    kind: python
    script:
      uri: gs://my-bucket/scripts/analyze.py
      source:
        type: gcs
        auth: gcp_service_account
    args:
      dataset: "{{ workload.dataset }}"
```

See `documentation/docs/reference/script_execution_v2.md` for the script descriptor.

---

## See also
- Variables/scopes: `documentation/docs/reference/variables_v2.md`
- Retry semantics: `documentation/docs/reference/retry_mechanism.md`
- Result storage (reference-first): `documentation/docs/reference/result_storage.md`
