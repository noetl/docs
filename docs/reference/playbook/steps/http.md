# HTTP in steps — current DSL

current DSL has no `tool: http` step type. Use an HTTP **tool task** (`kind: http`) inside `step.tool`.

```yaml
- step: call_api
  tool:
    - call:
        kind: http
        method: GET
        url: "{{ workload.api_url }}/v1/data"
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' and outcome.http.status in [429,500,502,503,504] }}"
                then: { do: retry, attempts: 5, backoff: exponential, delay: 2 }
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

## See also
- standard HTTP tool: `/docs/reference/tools/http`
- Retry semantics: `/docs/reference/retry_mechanism`
- Pagination pattern: `/docs/reference/pagination`
