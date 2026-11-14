---
sidebar_position: 1
title: Generated DSL reference
description: The NoETL playbook grammar and tool kinds, generated from the code that parses them.
---

# Generated DSL reference

:::info[Generated]
Generated from [noetl/server@765147ffe0d8](https://github.com/noetl/server/tree/765147ffe0d8ab916c28a53b7d410f40fa333b97/orchestrate-core/schema) (orchestrate-core 0.1.0). **Do not edit**: change the Rust types and regenerate. Machine-readable copies live on [noetl.ai](https://noetl.ai).
:::

These pages are generated from `noetl-orchestrate-core`, the Rust types the NoETL server parses
playbooks with. The hand-written guides elsewhere in this section explain the concepts; these
pages are the exact, current grammar.

| | |
|---|---|
| apiVersion | `noetl.io/v2` |
| Document kind | `Playbook` |
| orchestrate-core | `0.1.0` |
| Schema digest | `sha256:7c841140c76037ec82f64e6a0055743d037831b4d704b8e21492aa66f4eb58ef` |
| Source | [noetl/server@765147ffe0d8](https://github.com/noetl/server/commit/765147ffe0d8ab916c28a53b7d410f40fa333b97) |

- [Grammar](./grammar): every playbook construct and its fields.
- [Tool kinds](./tool-kinds): every `tool.kind` and whether it is enabled by default.

A running server reports the grammar it actually serves at `GET /api/dsl/version`; compare its
`schema_digest` with the one above. Machine-readable copies: [schema](https://noetl.ai/schema/v2/playbook.schema.json),
[manifest](https://noetl.ai/dsl/manifest.json), [llms.txt](https://noetl.ai/llms.txt).
