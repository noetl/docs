---
sidebar_position: 2
title: Quick Start for Developers
description: Get up and running with ai-meta in 10 minutes
---

# Quick Start for Developers

This guide gets you from zero to a working ai-meta setup in 10 minutes.

---

## 1. Clone and Initialize

```bash
git clone git@github.com:noetl/ai-meta.git
cd ai-meta
git submodule update --init --recursive
```

This gives you all 12 NoETL repos checked out at their pinned SHAs.

## 2. Verify the State

```bash
git submodule status --recursive
```

Every line should show a clean SHA with the submodule path. No `+` prefix (that means uncommitted changes).

## 3. Read the Current Memory

```bash
cat memory/current.md
```

This tells you what the team is working on right now — active priorities, recent decisions, and pointers to the latest compactions.

For recent uncompacted work, check the inbox:

```bash
ls memory/inbox/
```

## 4. Set Up Your AI Agent

### Claude Code
Nothing to configure. `CLAUDE.md` is auto-loaded. Rules are auto-loaded from `.claude/rules/` (symlinked to `agents/rules/`). Skills (`/memory-add`, `/memory-compact`, `/sync-note`, `/bump-pointer`) are available immediately.

### GitHub Copilot
Instructions auto-load from `.github/copilot-instructions.md`.

### Cursor
Instructions auto-load from `.cursorrules`.

### Any Other Agent
Point it to `AGENTS.md` first, then `agents/rules/` for rules and `agents/profiles/` for the behavioral profile.

## 5. Make Your First Memory Entry

Record a decision, investigation result, or work session:

```bash
./scripts/memory_add.sh "my-first-entry" "Explored the gateway auth flow and found X" "gateway,auth"
```

This creates a timestamped file in `memory/inbox/`. The author is auto-detected from your git config.

Commit it:

```bash
git add memory/inbox
git commit -m "memory(add): my-first-entry"
git push
```

## 6. Make a Cross-Repo Change

When your work touches multiple repos:

```bash
# 1. Work inside the submodule
cd repos/noetl
git checkout -b fix/something
# ... make changes, test ...
git commit -am "fix: something"
git push -u origin fix/something
# Open PR, get it reviewed, merge it

# 2. Back in ai-meta, bump the pointer
cd ../..
git submodule update --remote repos/noetl
git add repos/noetl
git commit -m "chore(sync): bump noetl to $(cd repos/noetl && git rev-parse --short HEAD)"
git push
```

## 7. Write a Sync Note

For multi-repo changes, create a sync note:

```bash
cp sync/TEMPLATE.md sync/issues/$(date +%Y-%m-%d)-my-topic.md
# Edit the file: fill in repos, PRs, SHAs, follow-ups
git add sync/issues/
git commit -m "chore(sync): add sync note for my-topic"
git push
```

Or if using Claude Code, just run `/sync-note "my-topic"`.

## 8. End of Day

Capture what you learned:

```bash
./scripts/memory_add.sh "end-of-day" "Summary of decisions and next steps" "tag1,tag2"
git add memory/inbox
git commit -m "memory(add): end-of-day"
git push
```

If the inbox has accumulated many entries, compact them:

```bash
./scripts/memory_compact.sh
git add memory
git commit -m "memory(compact): $(date +%Y-%m-%d)"
git push
```

---

## Available Skills (Claude Code Slash Commands)

| Command | What It Does |
|---|---|
| `/memory-add "title" "summary" "tags"` | Create and commit a memory entry |
| `/memory-compact` | Compact inbox entries into a summary |
| `/sync-note "topic"` | Create a sync note from the template |
| `/bump-pointer "repo"` | Update a submodule pointer after upstream merge |

---

## Rules to Follow

All rules are in `agents/rules/`. The essentials:

- **Public repo** — never commit secrets, tokens, or credentials
- **No product code** — only instructions, memory, sync notes, pointer bumps
- **Append-only memory** — never delete or overwrite inbox entries
- **Never rewrite history** on `main`
- **Atomic pointer bumps** — one logical change per commit
- **Use commit conventions**: `memory(add):`, `memory(compact):`, `memory(curate):`, `chore(sync):`, `docs(agents):`

---

## Next Steps

- Read [Shared Memory for Teams](shared-memory-multi-engineer) if working with other engineers
- Read [Agent Setup](agent-setup) for detailed per-agent configuration
- Read [Overview](overview) for the full memory system explanation
