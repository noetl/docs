---
sidebar_position: 0
title: AI Meta
description: Coordination hub, shared memory, and AI agent infrastructure for the NoETL ecosystem
---

# AI Meta

**Repository:** [github.com/noetl/ai-meta](https://github.com/noetl/ai-meta)

`ai-meta` is the coordination layer for the NoETL multi-repo ecosystem. It provides three things:

1. **Deterministic ecosystem state** — all NoETL repos pinned as Git submodules at exact SHAs
2. **Git-tracked shared memory** — a persistent knowledge store that survives across sessions and is shared across engineers and AI agents
3. **Agent infrastructure** — shared rules, skills, and profiles that any AI agent (Claude Code, Codex, Copilot, Cursor) can use

---

## Repository Layout

```
ai-meta/
├── AGENTS.md                        # Universal rules (all agents, all humans)
├── CLAUDE.md                        # Claude Code auto-bootstrap entry point
├── .cursorrules                     # Cursor entry point
├── .github/copilot-instructions.md  # GitHub Copilot entry point
│
├── agents/                          # SHARED agent infrastructure
│   ├── rules/                       #   7 modular rule files
│   ├── skills/                      #   4 workflow definitions (memory-add, compact, sync-note, bump-pointer)
│   └── profiles/                    #   per-agent behavioral profiles (claude, codex)
│
├── .claude/                         # Claude Code specific
│   ├── settings.json                #   permissions, hooks, env
│   ├── rules -> ../agents/rules     #   symlink to shared rules
│   ├── skills -> ../agents/skills   #   symlink to shared skills
│   └── agents/                      #   Claude subagent defs (frontmatter + @import)
│
├── memory/                          # Git-tracked shared memory
│   ├── current.md                   #   active working state (session bootstrap)
│   ├── timeline.md                  #   chronological index
│   ├── inbox/YYYY/MM/               #   raw timestamped entries
│   ├── compactions/                 #   periodic consolidated summaries
│   └── archive/YYYY/MM/            #   processed entries
│
├── scripts/                         # Automation
│   ├── memory_add.sh                #   create memory entry
│   └── memory_compact.sh            #   compact inbox -> summary
│
├── playbooks/                       # Operational runbooks
│   ├── how_to_use_ai_meta_day_to_day.md
│   ├── cross_repo_change.md
│   └── memory_compaction.md
│
├── sync/                            # Cross-repo coordination
│   ├── TEMPLATE.md                  #   structured sync note template
│   └── issues/                      #   per-issue tracking docs
│
└── repos/                           # Git submodules (12 ecosystem repos)
    ├── noetl/                       #   core Python engine
    ├── server/, worker/, gateway/   #   Rust services
    ├── cli/, tools/                 #   CLI and shared crates
    ├── ops/                         #   deployment automation
    ├── docs/                        #   this documentation site
    ├── gui/                         #   web UI
    └── apt/, homebrew-tap/, noetl.io/
```

---

## In This Section

| Page | What It Covers |
|---|---|
| [Overview](overview) | What ai-meta is, the memory system, day-to-day workflow |
| [Quick Start for Developers](quickstart) | Clone, setup, first memory entry, first sync note |
| [Agent Setup](agent-setup) | How each AI agent (Claude, Copilot, Cursor, Codex) connects |
| [Shared Memory for Teams](shared-memory-multi-engineer) | Concurrency patterns, team conventions, what is safe vs. coordinated |
| [How Agents Work](how-agents-work) | Deep dive: agent internals, RAG, context assembly, planning loops |
| [Indexes and Timelines](indexes-and-timelines) | How timeline.md, current.md, and topic indexes support retrieval |
| [Agent Orchestration](agent-orchestration) | Using NoETL as an agent registry and orchestrator (agents as playbooks) |
| [Status Transition Matrix](status-transition-matrix) | Canonical lifecycle ownership, terminal states, and testing rules for execution status |
