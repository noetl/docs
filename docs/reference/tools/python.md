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

Standard reminders:
- Use `workload` for immutable inputs, `ctx` for execution-scoped state, `iter` for iteration-scoped state — these are **template** names, resolved before the code runs.
- ⚠ They are **not** in scope inside `code:`. The code sees each input key as a bare global, plus `args` / `input_data` (the whole mapping), `variables`, `execution_id` and `step`. Bind anything the code needs through `input:` (or its legacy alias `args:`).
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

See `/docs/reference/script_execution` for the script descriptor.

---

## See also
- Variables/scopes: `/docs/reference/variables`
- Retry semantics: `/docs/reference/retry_mechanism`
- Result storage (reference-first): `/docs/reference/result_storage`
