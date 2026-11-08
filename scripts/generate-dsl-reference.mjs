#!/usr/bin/env node
// Render the generated NoETL DSL reference (docs/reference/dsl/generated/*)
// from the artifacts noetl/server commits under orchestrate-core/schema/.
// ai-meta RFC docs/rfc/dsl-knowledge-base.md, Phase 4: noetl.dev is the HUMAN
// view; the machine-readable home is noetl.ai. These pages are never edited
// by hand: change the Rust types, and the next run regenerates them.
//
//   node scripts/generate-dsl-reference.mjs [--ref <server ref, default main>]
//
// No dependencies (Node >= 20 for global fetch and crypto).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/reference/dsl/generated");
const args = process.argv.slice(2);
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "main";

async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "noetl-docs-generator", accept: "application/json" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// Same canonical form as noetl_orchestrate_core::dsl::digest.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const digest = (v) => "sha256:" + createHash("sha256").update(canonical(v), "utf8").digest("hex");

// MDX-safe prose: escape braces and angle brackets outside `code` spans,
// collapse newlines, and escape table pipes.
function prose(s = "") {
  return String(s)
    .replace(/\s*\n\s*/g, " ")
    .split("`")
    .map((seg, i) => (i % 2 ? seg : seg.replace(/[{}<>]/g, (c) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[c])))
    .join("`")
    .replace(/\|/g, "\\|")
    .trim();
}
const anchor = (name) => name.toLowerCase();

function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (s.$ref) { const n = s.$ref.split("/").pop(); return `[${n}](#${anchor(n)})`; }
  const alts = s.anyOf || s.oneOf;
  if (alts) {
    const parts = alts.map(typeOf).filter((t) => t !== "null");
    const nullable = alts.some((a) => a.type === "null");
    return [...new Set(parts)].join(" \\| ") + (nullable ? " (optional)" : "");
  }
  if (s.const !== undefined) return "`" + JSON.stringify(s.const) + "`";
  if (s.enum) return s.enum.map((e) => "`" + e + "`").join(", ");
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const opt = types.includes("null") && types.length > 1 ? " (optional)" : "";
  if (types.includes("array")) return "list of " + typeOf(s.items) + opt;
  if (types.includes("object") && s.additionalProperties && typeof s.additionalProperties === "object")
    return "map of " + typeOf(s.additionalProperties) + opt;
  if (s.type === "object" && s.additionalProperties && typeof s.additionalProperties === "object")
    return "map of " + typeOf(s.additionalProperties);
  if (Array.isArray(s.type)) return s.type.filter((t) => t !== "null").join(" \\| ");
  return s.type || "any";
}

function defSection(name, d) {
  const out = [`## ${name}`, ""];
  if (d.description) out.push(prose(d.description), "");
  const req = new Set(d.required || []);
  const props = d.properties || {};
  const keys = Object.keys(props);
  if (keys.length) {
    out.push("| Field | Type | Required | Description |", "|---|---|---|---|");
    for (const k of keys.sort((a, b) => (req.has(b) - req.has(a)) || a.localeCompare(b))) {
      const p = props[k];
      out.push(`| \`${k}\` | ${typeOf(p)} | ${req.has(k) ? "yes" : ""} | ${prose(p.description || "")} |`);
    }
    out.push("");
  } else if (d.anyOf || d.oneOf || d.enum) {
    out.push(`One of: ${typeOf(d)}`, "");
  }
  if (d.additionalProperties !== undefined && keys.length)
    out.push("_Other keys are accepted (the parser does not reject unknown keys)._", "");
  return out.join("\n");
}

const banner = (src) =>
  `:::info Generated\nGenerated from [noetl/server@${src.sha.slice(0, 12)}](https://github.com/noetl/server/tree/${src.sha}/orchestrate-core/schema) ` +
  `(orchestrate-core ${src.core}). **Do not edit**: change the Rust types and regenerate. ` +
  `Machine-readable copies live on [noetl.ai](https://noetl.ai).\n:::\n`;

const sha = (await getJson(`https://api.github.com/repos/noetl/server/commits/${encodeURIComponent(ref)}`)).sha;
const raw = (p) => `https://raw.githubusercontent.com/noetl/server/${sha}/orchestrate-core/schema/${p}`;
const schema = await getJson(raw("playbook.schema.json"));
const manifest = await getJson(raw("dsl-manifest.json"));
const src = { sha, core: manifest.orchestrate_core_version, digest: digest(schema) };

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "_category_.json"), JSON.stringify({ label: "Generated reference", position: 0 }, null, 2) + "\n");

writeFileSync(join(OUT, "index.md"), `---
sidebar_position: 1
title: Generated DSL reference
description: The NoETL playbook grammar and tool kinds, generated from the code that parses them.
---

# Generated DSL reference

${banner(src)}
These pages are generated from \`noetl-orchestrate-core\`, the Rust types the NoETL server parses
playbooks with. The hand-written guides elsewhere in this section explain the concepts; these
pages are the exact, current grammar.

| | |
|---|---|
| apiVersion | \`${manifest.api_version}\` |
| Document kind | \`${manifest.document_kind}\` |
| orchestrate-core | \`${manifest.orchestrate_core_version}\` |
| Schema digest | \`${src.digest}\` |
| Source | [noetl/server@${sha.slice(0, 12)}](https://github.com/noetl/server/commit/${sha}) |

- [Grammar](./grammar): every playbook construct and its fields.
- [Tool kinds](./tool-kinds): every \`tool.kind\` and whether it is enabled by default.

A running server reports the grammar it actually serves at \`GET /api/dsl/version\`; compare its
\`schema_digest\` with the one above. Machine-readable copies: [schema](https://noetl.ai/schema/v2/playbook.schema.json),
[manifest](https://noetl.ai/dsl/manifest.json), [llms.txt](https://noetl.ai/llms.txt).
`);

const kinds = manifest.tool_kinds
  .map((k) => `| \`${k.name}\` | ${k.enabled ? "yes" : "no"} | ${k.gated ? `\`${k.gate_env}\`` : ""} |`)
  .join("\n");
writeFileSync(join(OUT, "tool-kinds.md"), `---
sidebar_position: 3
title: Tool kinds
description: Every tool.kind the NoETL parser accepts, and which are behind a flag.
---

# Tool kinds

${banner(src)}
Enabled under default gates. A gated kind is rejected at registration unless its flag is
\`true\` on that server. **Accepted is not executable**: which kinds a worker can actually run is
reported by workers, not by the parser.

| Kind | Enabled by default | Flag |
|---|---|---|
${kinds}
`);

const defs = schema.$defs || {};
const order = ["Step", "ToolDefinition", "ToolSpec", "PipelineItem", "EvalEntry", "EvalCondition", "EvalElse",
  "Loop", "LoopSpec", "LoopMode", "FrameSpec", "CursorClaim", "NextSpec", "NextRouter", "NextRouterSpec", "NextArc",
  "CanonicalNextTarget", "StepSpec", "Metadata", "KeychainDef", "Residency", "WorkbookTask", "ToolKind"];
const names = [...order.filter((n) => defs[n]), ...Object.keys(defs).filter((n) => !order.includes(n)).sort()];
const root = { description: schema.description, properties: schema.properties, required: schema.required };
writeFileSync(join(OUT, "grammar.md"), `---
sidebar_position: 2
title: Grammar
description: Every NoETL playbook construct and field, generated from the parser's types.
---

# Grammar

${banner(src)}
${defSection("Playbook", root)}
${names.map((n) => defSection(n, defs[n])).join("\n")}`);

console.log(`generated from noetl/server@${sha.slice(0, 12)} ${src.digest}`);
