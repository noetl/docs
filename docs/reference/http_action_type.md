---
sidebar_position: 12
title: HTTP Action Details
description: HTTP tool usage and configuration in NoETL current DSL playbooks
---

# HTTP in NoETL 

This page previously documented legacy HTTP shapes such as:
- `tool: http` (scalar tool)
- `endpoint:` (instead of `url:`)
- workbook-style `type: http` tasks with `return:` templates

current DSL uses HTTP as a **tool task** (`kind: http`) inside `step.tool`, with:
- retry/polling/pagination via `task.spec.policy.rules`
- step routing via `step.next` router arcs

## Minimal example

```yaml
- step: call_api
  tool:
    - call:
        kind: http
        method: GET
        url: "https://httpbin.org/get"
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

## See also
- standard HTTP tool: `/docs/reference/tools/http`
- Retry semantics: `/docs/reference/retry_mechanism`
- Pagination pattern: `/docs/reference/pagination`
