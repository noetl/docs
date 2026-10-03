# Loops/iteration in steps — current DSL

current DSL expresses iteration as a **step modifier**, not a step type:

- `step.loop` defines fan-out (`in` + `iterator` + `loop.spec`)
- iteration-local state lives under `iter.*`
- streaming/pagination uses task policy (`do: jump` / `do: break`)

## See also
- Loop iteration guide: `/docs/reference/iterator`
- Pagination pattern: `/docs/reference/pagination`
- Step spec: `/docs/reference/dsl/step_spec`
