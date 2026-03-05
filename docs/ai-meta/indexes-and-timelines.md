---
sidebar_position: 6
title: Indexes and Timelines
description: How memory indexes and timelines work for agent retrieval in ai-meta
---

# Indexes and Timelines in Git-Tracked Long Memory

This guide explains what “indexes” and “timelines” look like in a Git-tracked long-memory repo (like `noetl/ai-meta`), why they matter, and how AI agents use them for retrieval (RAG) and context assembly.

---

## 1) What an “index” is in an agent-friendly repo

An **index** is a small, stable “routing table” that points to high-signal artifacts. It’s designed to help an agent (or a human) answer:

- *Where is the latest summary?*
- *Where is the decision record for topic X?*
- *What changed across repos last week?*

Key principle: **indexes should be pointer-heavy, not copy-heavy**.

Good indexes mostly contain:
- file paths,
- short one-line descriptors,
- dates and scopes,
- occasionally tags.

They avoid:
- long prose,
- giant pasted diffs,
- full duplicated content.

---

## 2) Timeline index (`memory/timeline.md`)

A **timeline** is a chronological table-of-contents. It is optimized for:

- recency-first retrieval (“what happened recently?”),
- rehydrating context at the start of a session,
- selecting the latest compaction(s) quickly.

### Example

```md
# Memory Timeline

## 2026-03
- 2026-03-03 — Memory system enabled (inbox entry)
  - Inbox: memory/inbox/2026/03/20260303-192537-ai-meta-memory-system-enabled.md
- 2026-03-03 — Compaction: 20260303-192541
  - Compaction: memory/compactions/20260303-192541.md

## 2026-02
- 2026-02-28 — Gateway release tagging + bake plan
  - Inbox: memory/inbox/2026/02/20260228-103000-gateway-release-tag-bake.md
- 2026-02-28 — Compaction: 20260228-180200
  - Compaction: memory/compactions/20260228-180200.md
```

### Why agents like it

- One file provides “what’s new” and “where are the summaries”.
- Lexicographic sorting aligns with chronology when filenames are timestamped.
- It’s low-token but high-value: perfect for context windows.

---

## 3) Current snapshot (`memory/current.md`)

`current.md` is the “working memory”: what matters *now* plus pointers to the best references.

It’s optimized for:

- bootstrapping a new session,
- minimizing “re-reading the world”,
- keeping priorities, risks, and recent compactions visible.

### Example

```md
# Current Memory (Working State)

## Active Priorities
- Unify release workflows across gateway/server/worker
- Keep submodule SHAs consistent after merges
- Maintain public-safe memory policy (no secrets)

## Known Issues / Risks
- Cross-repo changes require ordered merges
- Avoid copying large diffs into ai-meta (prefer links + pointers)

## Latest Compactions
- 2026-03-03 — memory/compactions/20260303-192541.md
- 2026-02-28 — memory/compactions/20260228-180200.md

## References (high-signal docs)
- Repo rules: AGENTS.md + agents/rules/
- Agent profiles: agents/profiles/codex.md, agents/profiles/claude.md
- Sync notes: sync/2026/03/
```

### Why agents like it

- It’s the first file to read for “what should I do next?”
- It reduces retrieval time: it points directly to the best summaries.

---

## 4) Topic / tag index (optional but very useful)

A topical index is a “jump table” by area, often called `memory/index.md`.

It’s optimized for:

- retrieval by topic (“release”, “dsl”, “gateway”, “ui”, “runtime”),
- quick RAG packing for specific tasks.

### Example

```md
# Memory Index (Topics)

## Release / CI
- memory/compactions/20260303-192541.md
- sync/2026/03/20260303-gateway-tag-bake-publish.md

## Submodules / Ecosystem coordination
- memory/inbox/2026/03/20260303-192537-ai-meta-memory-system-enabled.md
- sync/2026/02/20260228-submodule-bump.md

## DSL / Docs
- memory/compactions/20260228-180200.md
- repos/docs (submodule)
```

### Rules of thumb

- Keep entries short (one line each).
- Prefer links/paths over pasted content.
- Use tags that match how your team thinks (“release”, “ci”, “gateway”, “docs”).

---

## 5) Sync index (`sync/index.md` or `sync/README.md`)

Sync notes are “what changed across repos.” An index helps when there are many.

### Example

```md
# Sync Notes Index

## 2026-03
- 20260303-gateway-tag-bake-publish.md — unify publish automation across gateway/server (PR links inside)

## 2026-02
- 20260228-submodule-bump.md — bump ecosystem SHAs after merges
```

---

## 6) How agents use indexes in RAG + context assembly

When a new task begins, a typical agent retrieval strategy is:

1) Read `AGENTS.md` + `agents/rules/` (rules and guardrails)
2) Read `memory/current.md` (working snapshot)
3) Use `memory/timeline.md` to pick the newest compaction(s)
4) Pull a few relevant `sync/issues/*.md` notes
5) Only then read specific code files inside `repos/<target-submodule>/...`

This works because indexes keep the “routing” cheap and deterministic:

- The agent doesn’t waste tokens scanning raw history.
- It gets a curated, compact set of pointers first.
- It then “rehydrates” details on demand via targeted reads and search.

---

## 7) Why naming conventions matter for indexes

Indexes work best when filenames encode meaning:

- timestamps sort naturally: `YYYYMMDD-HHMMSS-topic.md`
- month folders constrain searches: `YYYY/MM/`
- stable templates make summarization and retrieval consistent

This is why `ai-meta` uses:

- inbox entries in `memory/inbox/YYYY/MM/`
- compactions in `memory/compactions/`
- a “current snapshot” in `memory/current.md`
- a chronological TOC in `memory/timeline.md`

---

## 8) Minimal recommendation (what to implement first)

If you want the smallest effective setup:

1) `memory/current.md` (working snapshot + links)  
2) `memory/timeline.md` (chronological TOC)  

Then later add:

3) `memory/index.md` (topic index)  
4) `sync/index.md` (sync note index)

That’s enough to make long-running projects agent-friendly without adding complexity.
