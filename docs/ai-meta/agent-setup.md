---
sidebar_position: 3
title: Agent Setup
description: How to configure AI coding agents to work with ai-meta
---

# Agent Setup

This guide explains how to configure each supported AI coding agent to work with `ai-meta`. The infrastructure is designed to be **agent-agnostic** — rules, skills, and profiles are defined once in a shared `agents/` directory and consumed by each agent through its native integration mechanism.

---

## Architecture: Shared vs. Agent-Specific

```
agents/                              # SHARED (all agents read from here)
  ├── rules/                         #   modular rule files
  │   ├── safety.md
  │   ├── allowed-content.md
  │   ├── commit-conventions.md
  │   ├── memory-workflow.md
  │   ├── submodules.md
  │   ├── logging.md
  │   └── ops-deploy.md
  ├── skills/                        #   workflow definitions
  │   ├── memory-add/SKILL.md
  │   ├── memory-compact/SKILL.md
  │   ├── sync-note/SKILL.md
  │   └── bump-pointer/SKILL.md
  └── profiles/                      #   behavioral profiles
      ├── claude.md
      └── codex.md

.claude/                             # Claude Code integration (symlinks)
  ├── settings.json
  ├── rules -> ../agents/rules
  ├── skills -> ../agents/skills
  └── agents/
      ├── claude.md                  #   @import from agents/profiles/
      └── codex.md

.github/copilot-instructions.md      # Copilot entry point
.cursorrules                         # Cursor entry point
CLAUDE.md                            # Claude Code auto-bootstrap
AGENTS.md                            # Universal rules (all agents)
```

---

## Claude Code

### What loads automatically

Claude Code auto-discovers and loads:

1. **`CLAUDE.md`** — loaded at session start, contains bootstrap instructions and project structure reference
2. **`.claude/rules/`** — symlinked to `agents/rules/`, all rule files auto-loaded (some are path-scoped via YAML frontmatter)
3. **`.claude/skills/`** — symlinked to `agents/skills/`, provides slash commands (`/memory-add`, `/memory-compact`, `/sync-note`, `/bump-pointer`)
4. **`.claude/settings.json`** — permissions (allow/deny specific commands) and hooks (session start/stop behavior)
5. **`.claude/agents/`** — subagent definitions that `@import` from `agents/profiles/`

### Available slash commands

| Command | What It Does |
|---|---|
| `/memory-add "title" "summary" "tags"` | Create and commit a memory entry |
| `/memory-compact` | Compact inbox entries into a summary |
| `/sync-note "topic"` | Create a sync note from the template |
| `/bump-pointer "repo"` | Update a submodule pointer after upstream merge |

### Permissions and hooks

The `.claude/settings.json` configures:

- **Allowed commands**: git operations, memory scripts, file reads
- **Denied commands**: force push, hard reset, destructive operations on submodules
- **Session start hook**: prints current memory status (inbox count, last compaction)
- **Session stop hook**: reminds the agent to persist any meaningful work as a memory entry

### Nothing to configure

If you have Claude Code installed and clone `ai-meta`, everything works immediately. The `CLAUDE.md` file, rules, skills, and settings are all auto-discovered.

---

## GitHub Copilot

### How it works

Copilot automatically loads instructions from `.github/copilot-instructions.md`. This file:

- Points Copilot to `AGENTS.md` for mandatory rules
- References `agents/rules/` for detailed per-topic rules
- References `agents/profiles/` for the behavioral profile
- Describes the memory workflow and commit conventions

### Setup

**Automatic** — instructions load from `.github/copilot-instructions.md` when you open the repo in VS Code with Copilot enabled.

**Manual** — you can also configure it explicitly in `.vscode/settings.json`:

```json
{
  "github.copilot.chat.instructionFiles": [
    ".github/copilot-instructions.md"
  ]
}
```

### Usage

Use Copilot chat or inline suggestions as normal. The instructions are applied automatically. You can also explicitly reference agent files:

```
@workspace Follow the guidelines in AGENTS.md and agents/rules/
```

---

## Cursor

### How it works

Cursor automatically loads instructions from `.cursorrules` in the project root. This file:

- Points Cursor to `AGENTS.md` for mandatory rules
- References `agents/rules/` for detailed per-topic rules
- References `agents/profiles/` for the behavioral profile
- Describes the memory workflow and commit conventions

### Setup

**Automatic** — instructions load from `.cursorrules` when you open the repo in Cursor.

**Alternative** — you can also reference the rules in Cursor settings under "Rules for AI".

---

## Codex (OpenAI)

### How it works

Codex does not have a standardized auto-discovery mechanism like Claude Code. Instead:

1. Start by instructing Codex to read `AGENTS.md`
2. Point it to `agents/profiles/codex.md` for its behavioral profile
3. Reference `agents/rules/` for specific rules
4. Reference `agents/skills/` for available workflows

### Typical session start prompt

```
Read these files in order:
1. AGENTS.md (mandatory rules)
2. agents/profiles/codex.md (your execution profile)
3. memory/current.md (active working state)
4. Latest entries in memory/inbox/ (recent work)
```

---

## Any Other Agent

For agents not listed above:

1. **Start with `AGENTS.md`** — this is the universal rules file that all agents must follow
2. **Read `agents/rules/`** — modular rule files covering safety, content, commits, memory, submodules, logging, and deployment
3. **Read `agents/profiles/`** — choose or adapt the closest behavioral profile
4. **Read `agents/skills/`** — workflow definitions that describe how to perform common tasks (memory entries, compaction, sync notes, pointer bumps)
5. **Bootstrap memory** — read `memory/current.md` for active state, then scan `memory/inbox/` for recent uncompacted work

---

## Rules reference

All rules live in `agents/rules/` and are organized by topic:

| File | Scope | What It Covers |
|---|---|---|
| `safety.md` | All files | No secrets, no history rewriting, public repo safety |
| `allowed-content.md` | All files | What types of content can be committed to ai-meta |
| `commit-conventions.md` | All files | Commit message prefix format and conventions |
| `memory-workflow.md` | `memory/**`, `scripts/**` | How to create, compact, and curate memory entries |
| `submodules.md` | `repos/**` | How to work with git submodules safely |
| `logging.md` | Service repos | Structured logging conventions for NoETL services |
| `ops-deploy.md` | `repos/ops`, `repos/noetl` | NoETL image build, deploy, and release workflow |

Rules that include YAML frontmatter with `path` or `globs` fields are **path-scoped** — they only apply when working in matching directories. This keeps the agent's context focused and relevant.

---

## Skills reference

Skills are workflow definitions that describe step-by-step procedures. In Claude Code, they become slash commands. For other agents, they serve as executable runbooks.

| Skill | Arguments | What It Does |
|---|---|---|
| `memory-add` | `"title" "summary" "tags"` | Creates a timestamped memory entry, stages, and commits |
| `memory-compact` | *(none)* | Runs compaction, stages all memory changes, commits |
| `sync-note` | `"topic"` | Creates a sync note from template, prompts for details, commits |
| `bump-pointer` | `"repo-name"` | Updates submodule to latest remote SHA, shows diff, commits |

Each skill's `SKILL.md` file contains the exact steps to follow, making them reproducible across any agent.

---

## Profiles reference

Profiles define how a specific agent should behave in the ai-meta context:

| Profile | Best For |
|---|---|
| `agents/profiles/claude.md` | Architecture reasoning, documentation, multi-file coordination, memory curation, cross-repo analysis |
| `agents/profiles/codex.md` | Code edits, test-driven changes, repo navigation, implementation inside submodules |

Both profiles follow the same rules (`AGENTS.md` + `agents/rules/`) and write to the same memory pipeline. The memory system is agent-agnostic by design.
