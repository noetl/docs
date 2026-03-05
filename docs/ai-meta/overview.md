---
sidebar_position: 1
title: Overview
description: What ai-meta is and how it works as the coordination layer for the NoETL ecosystem
---

# ai-meta Overview

**Repository:** [github.com/noetl/ai-meta](https://github.com/noetl/ai-meta)

`ai-meta` is the coordination and shared memory repository for the NoETL ecosystem. It tracks all participating repos as **git submodules**, provides a Git-tracked **long memory** system for AI agents and engineers, and defines shared **rules, skills, and profiles** that any AI coding agent can use.

---

## What ai-meta handles

- **Cross-repo coordination** — plan and track multi-repo refactors, releases, and migrations
- **Shared memory** — Git-tracked decision log (inbox → compaction → current state)
- **Ecosystem snapshot** — all NoETL repos pinned at exact SHAs via submodules
- **Agent infrastructure** — shared rules, skills, and behavioral profiles for AI agents
- **Sync notes** — lightweight "what changed across repos" records with PR links and SHAs
- **Playbooks** — repeatable checklists for common orchestration routines

---

## Repository layout

```
ai-meta/
├── AGENTS.md                          # global rules for all AI agents and humans
├── CLAUDE.md                          # Claude Code auto-bootstrap entry point
├── .github/copilot-instructions.md    # GitHub Copilot entry point
├── .cursorrules                       # Cursor entry point
│
├── agents/                            # SHARED agent infrastructure (agent-agnostic)
│   ├── rules/                         #   modular rule files (safety, commits, memory, etc.)
│   ├── skills/                        #   workflow definitions (memory-add, sync-note, etc.)
│   └── profiles/                      #   per-agent behavioral profiles
│       ├── claude.md
│       └── codex.md
│
├── .claude/                           # Claude Code integration
│   ├── settings.json                  #   permissions, hooks, environment
│   ├── rules -> ../agents/rules       #   symlink to shared rules
│   ├── skills -> ../agents/skills     #   symlink to shared skills
│   └── agents/                        #   Claude-specific subagent definitions
│       ├── claude.md                  #     (@import from agents/profiles/)
│       └── codex.md
│
├── memory/                            # Git-tracked long memory
│   ├── inbox/                         #   raw, uncompacted entries (append-only)
│   │   └── YYYY/MM/                   #     date-partitioned directories
│   ├── compactions/                   #   periodic summaries of inbox batches
│   ├── archive/                       #   processed entries moved from inbox
│   ├── current.md                     #   active working state ("what matters now")
│   ├── timeline.md                    #   chronological index of all entries
│   └── README.md                      #   memory system rules
│
├── sync/                              # cross-repo change tracking
│   ├── TEMPLATE.md                    #   standard template for sync notes
│   └── issues/                        #   individual sync notes per topic
│
├── playbooks/                         # repeatable orchestration checklists
├── scripts/                           # automation helpers
│   ├── memory_add.sh                  #   create a memory entry
│   └── memory_compact.sh             #   compact inbox into summary
│
└── repos/                             # all NoETL repos as git submodules
    ├── noetl/                         #   core engine
    ├── server/                        #   server component
    ├── worker/                        #   worker component
    ├── gateway/                       #   API gateway
    ├── cli/                           #   CLI tool
    ├── docs/                          #   documentation site
    ├── ops/                           #   deployment and operations
    ├── tools/                         #   shared tooling
    └── ...                            #   other ecosystem repos
```

---

## The memory system

The memory system is Git-native: raw notes land in an **inbox**, then you periodically **compact** them into summarized artifacts and update the **current working state**.

### How the pipeline works

```
1. ADD           ./scripts/memory_add.sh "title" "summary" "tags"
                 → creates timestamped file in memory/inbox/YYYY/MM/

2. COMMIT        git add memory/inbox && git commit -m "memory(add): title"

3. COMPACT       ./scripts/memory_compact.sh
                 → summarizes all inbox entries into memory/compactions/
                 → updates memory/current.md and memory/timeline.md
                 → moves originals to memory/archive/

4. COMMIT        git add memory && git commit -m "memory(compact): scope"
```

### Memory entry format

Every entry follows a consistent template:

```markdown
# Descriptive Title
- Timestamp: 2026-03-05T14:30:00Z
- Author: Engineer Name
- Tags: topic1,topic2

## Summary
What happened, one paragraph.

## Actions
- What was done or needs doing

## Repos
- Which repos were affected

## Related
- Links to sync notes or other memory entries
```

### Key properties

- **Append-only** — never delete or overwrite inbox entries
- **Concurrent-safe** — timestamped filenames prevent merge conflicts
- **Git-auditable** — every change is a commit with a conventional prefix
- **Agent-readable** — consistent templates enable mechanical parsing

---

## Agent infrastructure

ai-meta provides a **shared, agent-agnostic** infrastructure layer that any AI coding agent can use. Agent-specific tools (Claude Code, Copilot, Cursor) integrate via thin wrappers that reference the shared definitions.

### Shared layer (`agents/`)

| Directory | Purpose |
|---|---|
| `agents/rules/` | Modular rule files: safety, allowed content, commit conventions, memory workflow, submodule handling, logging, ops/deploy |
| `agents/skills/` | Workflow definitions with steps: `memory-add`, `memory-compact`, `sync-note`, `bump-pointer` |
| `agents/profiles/` | Per-agent behavioral profiles defining role, strengths, constraints, and execution patterns |

### Agent entry points

| Agent | Entry Point | How It Works |
|---|---|---|
| **Claude Code** | `CLAUDE.md` (auto-loaded) | Rules via `.claude/rules/` symlink → `agents/rules/`. Skills via `.claude/skills/` symlink → `agents/skills/`. Settings in `.claude/settings.json`. |
| **GitHub Copilot** | `.github/copilot-instructions.md` | References `agents/rules/` and `agents/profiles/` directly |
| **Cursor** | `.cursorrules` | References `agents/rules/` and `agents/profiles/` directly |
| **Any other agent** | `AGENTS.md` | Start here, then read `agents/rules/` and `agents/profiles/` |

### Why symlinks?

Claude Code auto-loads rules from `.claude/rules/` and skills from `.claude/skills/`. Rather than duplicating content, these directories are **symlinks** to the shared `agents/` directory:

```
.claude/rules  →  ../agents/rules
.claude/skills →  ../agents/skills
```

This means rules and skills are maintained once in `agents/` and automatically available to Claude Code, Copilot, Cursor, and any future agent.

---

## Submodule workflow

All NoETL repos are tracked as git submodules under `repos/`. This provides a deterministic ecosystem snapshot — the exact state of every repo at any point in time.

### Day-to-day workflow

1. **Work inside submodules** — code changes happen in the relevant `repos/<name>` directory
2. **Open PRs upstream** — each submodule has its own remote repository
3. **Bump pointers after merge** — update `ai-meta` to point to the new SHA
4. **Record sync notes** — capture what changed across repos, PR links, resulting SHAs
5. **Add memory entries** — record decisions, outcomes, and follow-ups
6. **Compact periodically** — keep the active memory small and useful

### Commit conventions

| Prefix | When to use |
|---|---|
| `memory(add): <topic>` | New memory entry committed |
| `memory(compact): <scope>` | Compaction run committed |
| `memory(curate): <scope>` | Manual curation of current.md |
| `chore(sync): bump <repo> to <sha>` | Submodule pointer updated |
| `docs(agents): <description>` | Agent infrastructure changes |

---

## How it ties together

```
Engineer / AI Agent
        │
        ├── Read AGENTS.md + memory/current.md     (bootstrap context)
        ├── Work inside repos/<submodule>           (implement changes)
        ├── Open PRs, get reviews, merge            (upstream workflow)
        ├── Bump submodule pointers in ai-meta      (chore(sync): bump)
        ├── Write sync note in sync/issues/         (cross-repo tracking)
        ├── Add memory entry via memory_add.sh      (memory(add): topic)
        └── Compact memory periodically             (memory(compact): scope)
```

The result: every decision, every cross-repo change, and every ecosystem state transition is captured in Git, retrievable by any agent or engineer in future sessions.

---

## Next steps

- [Quick Start](quickstart) — get from zero to a working setup in 10 minutes
- [Agent Setup](agent-setup) — detailed per-agent configuration instructions
- [Shared Memory for Teams](shared-memory-multi-engineer) — concurrency patterns for multi-engineer workflows
- [How Agents Work](how-agents-work) — deep dive into agent internals and how ai-meta supports them
- [Indexes and Timelines](indexes-and-timelines) — how the memory indexes work for retrieval
- [Agent Orchestration](agent-orchestration) — using NoETL as an agent registry and orchestrator
