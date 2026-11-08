---
sidebar_position: 1
title: Generated DSL reference
description: The NoETL playbook grammar and tool kinds, generated from the code that parses them.
---

# Generated DSL reference

:::info Generated
Generated from [noetl/server@f939ad4d9f59](https://github.com/noetl/server/tree/f939ad4d9f5910b7e669cbb6b87c99742fd547bb/orchestrate-core/schema) (orchestrate-core 0.1.0). **Do not edit**: change the Rust types and regenerate. Machine-readable copies live on [noetl.ai](https://noetl.ai).
:::

These pages are generated from `noetl-orchestrate-core`, the Rust types the NoETL server parses
playbooks with. The hand-written guides elsewhere in this section explain the concepts; these
pages are the exact, current grammar.

| | |
|---|---|
| apiVersion | `noetl.io/v2` |
| Document kind | `Playbook` |
| orchestrate-core | `0.1.0` |
| Schema digest | `sha256:de6519f1f025dcb0e4743e321cff30e8ac4800d38acaaecf8249c00a13ab9ad6` |
| Source | [noetl/server@f939ad4d9f59](https://github.com/noetl/server/commit/f939ad4d9f5910b7e669cbb6b87c99742fd547bb) |

- [Grammar](./grammar): every playbook construct and its fields.
- [Tool kinds](./tool-kinds): every `tool.kind` and whether it is enabled by default.

A running server reports the grammar it actually serves at `GET /api/dsl/version`; compare its
`schema_digest` with the one above. Machine-readable copies: [schema](https://noetl.ai/schema/v2/playbook.schema.json),
[manifest](https://noetl.ai/dsl/manifest.json), [llms.txt](https://noetl.ai/llms.txt).
