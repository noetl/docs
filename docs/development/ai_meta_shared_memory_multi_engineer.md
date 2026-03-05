# Shared Memory for AI Agents in Multi-Engineer Teams

How to use `ai-meta` as a persistent, Git-tracked shared memory layer when multiple engineers and AI agents work across the NoETL ecosystem concurrently.

---

## Who This Is For

- Engineers using Claude Code, Codex, Copilot, or other AI agents against the NoETL repos.
- Teams where two or more people (or agents) push changes to the ecosystem in the same day.
- Anyone evaluating whether `ai-meta` is suitable as the coordination backbone for their workflow.

---

## Can AI Agents Actually Use This as Memory?

Yes. The structure is designed for it and works today. Here is what each agent capability maps to.

### What agents can do right now

| Capability | How it works in ai-meta |
|---|---|
| **Load context at session start** | Read `memory/current.md` + scan `memory/inbox/` + check `sync/issues/` |
| **Persist knowledge across sessions** | Run `scripts/memory_add.sh`, commit with `memory(add):` prefix |
| **Understand ecosystem state** | `git submodule status --recursive` shows exact pinned SHAs |
| **Track multi-step work** | `sync/issues/YYYY-MM-DD-<repo>-issue-<id>-<topic>.md` captures progression |
| **Follow project rules** | `AGENTS.md` + `agents/claude.md` / `agents/codex.md` define constraints |
| **Compact accumulated knowledge** | Run `scripts/memory_compact.sh` to roll inbox into summaries |

### Session bootstrapping (what an agent should read first)

When starting a new session in `ai-meta`, an agent should load context in this order:

```
1. AGENTS.md                           # hard rules, safety constraints
2. memory/current.md                   # active priorities, recent compactions
3. memory/inbox/ (latest entries)      # uncompacted recent work
4. sync/issues/ (active issues)        # in-flight cross-repo changes
5. agents/<agent-name>.md              # agent-specific execution profile
```

This gives the agent a complete picture of what matters now, what work is in progress, and what rules to follow, all within a small token budget.

### Claude Code specifics

Claude Code automatically loads files named `CLAUDE.md` at each directory level. The `ai-meta` root uses `AGENTS.md` instead. To enable automatic bootstrapping, add a root `CLAUDE.md` that references the memory system:

```markdown
# Claude Code Entry Point

Read these files at session start (in order):
1. AGENTS.md (mandatory rules for this repo)
2. memory/current.md (active working state)
3. Latest entries in memory/inbox/ (recent uncompacted work)
4. agents/claude.md (Claude-specific execution profile)
```

This single file turns memory loading from a manual step into an automatic one.

---

## How the Memory Pipeline Works for Teams

### The inbox is naturally concurrent

The `scripts/memory_add.sh` script generates filenames with second-precision timestamps:

```
memory/inbox/2026/03/20260303-202428-noetl-issue-244-lease-expiry.md
memory/inbox/2026/03/20260303-210250-issue-244-fix-started.md
```

Two engineers creating entries simultaneously will always produce different filenames. Since each entry is a separate file in a date-partitioned directory, there are **zero merge conflicts on inbox writes**. This is the strongest property of the design.

### Memory entry anatomy

Every entry follows the same template:

```markdown
# <descriptive title>
- Timestamp: 2026-03-03T20:24:28Z
- Tags: issue,distributed,nats,lease

## Summary
<What happened, one paragraph>

## Actions
- <What was done or needs doing>

## Repos
- <Which repos were affected>
```

The consistency matters: agents can parse entries mechanically, and humans can scan them quickly.

### The compaction cycle

```
inbox/          Append raw entries (safe concurrent writes)
    |
    v
compact.sh      Roll all inbox entries into one compaction file
    |
    +---> compactions/   Consolidated summary
    +---> current.md     Append compaction reference
    +---> timeline.md    Append chronological entry
    +---> archive/       Move originals out of inbox
```

Compaction is a batch operation. It processes **all** inbox entries at once and moves them to archive. This is simple and correct for a single operator, but requires coordination in a team (see concurrency section below).

---

## Multi-Engineer Concurrency Patterns

### What works without coordination

These operations are safe for any number of concurrent engineers:

| Operation | Why it is safe |
|---|---|
| Adding inbox entries | Unique filenames, no shared state |
| Reading `current.md` | Read-only, no side effects |
| Working inside different submodules | Independent git repos |
| Adding sync notes for different issues | Separate files per issue |
| Bumping different submodule pointers | Different lines in the git index |

### What requires coordination

| Operation | Risk | Mitigation |
|---|---|---|
| **Compaction** | Processes all inbox entries; concurrent compactions can race or miss entries | Assign one person/agent per compaction window (daily or weekly) |
| **Bumping the same submodule** | Two engineers merging different PRs in the same repo create conflicting pointer updates | Rebase `ai-meta` before committing pointer bumps; keep bump commits atomic |
| **Editing `current.md` manually** | Direct edits to the same file create merge conflicts | Keep manual edits rare; let compaction be the primary write path |
| **Editing the same sync note** | Two people updating the same issue tracking doc | Each engineer appends a dated section rather than editing existing sections |

### Recommended team conventions

**1. One compactor per cycle.**
Decide who compacts (or schedule it). If using AI agents, one agent compacts at end-of-day. Others only add inbox entries.

**2. Always pull before bumping pointers.**
```bash
git pull --ff-only
git submodule update --init --recursive
# Then bump pointers
```

**3. Keep pointer bump commits atomic.**
One commit per logical change set. If you bumped `repos/ops` and `repos/noetl` together because they are related, commit them together. If they are independent, commit separately.

**4. Append, don't edit, sync notes.**
When updating an existing issue sync note, add a new dated section at the bottom:

```markdown
## Update 2026-03-04

- PR #248 merged, addresses regression
- New SHA: `a1b2c3d4`
- Follow-up: run integration tests on kind cluster
```

This eliminates merge conflicts on shared issue tracking docs.

---

## Recommended Improvements

### Add an Author field to memory entries

The current entry template has `Timestamp` and `Tags` but no author. In a team, knowing who created an entry matters for context and accountability.

Update `scripts/memory_add.sh` to accept an optional author parameter:

```markdown
# <title>
- Timestamp: 2026-03-03T20:24:28Z
- Author: <engineer or agent name>
- Tags: tag1,tag2
```

Alternatively, infer authorship from `git log --format='%an' -1` at commit time.

### Cross-reference memory and sync notes

Memory entries and sync notes often track the same work but do not link to each other. Adding a `## Related` section helps agents and humans navigate:

In a memory entry:
```markdown
## Related
- sync/issues/2026-03-03-noetl-issue-244-lease-expiry.md
```

In a sync note:
```markdown
## Memory Entries
- memory/inbox/2026/03/20260303-202428-noetl-issue-244-lease-expiry.md
- memory/inbox/2026/03/20260303-210250-issue-244-fix-started.md
```

### Curate `current.md` periodically

The compaction script appends to `current.md`, which means it grows with every compaction cycle. Over time, it becomes a long list of compaction references rather than a useful "what matters now" snapshot.

Schedule a periodic manual curation (monthly or after major milestones):

1. Review all compaction references in `current.md`.
2. Rewrite the `Active Focus` and `Open Items` sections to reflect current reality.
3. Archive old compaction references below a `## History` fold.
4. Commit as `memory(curate): refresh current.md for <month>`.

This keeps the file useful as a session bootstrap document.

### Add a root `CLAUDE.md` for automatic agent bootstrapping

As described in the Claude Code section above, a minimal root `CLAUDE.md` ensures that Claude Code automatically loads the memory context instead of requiring manual instruction.

---

## How Different Agents Divide the Work

The `agents/` directory defines per-agent profiles. In practice, a team might use agents like this:

| Agent | Strengths | Typical ai-meta tasks |
|---|---|---|
| **Claude Code** | Architecture reasoning, documentation, multi-file coordination | Memory entries, sync notes, playbook updates, current.md curation, cross-repo analysis |
| **Codex** | Code edits, test-driven changes, repo navigation | Implement fixes inside `repos/*`, run tests, prepare PR branches |
| **Copilot** | Inline completions, quick edits within a single file | Fast edits inside submodules during active development |

What matters is that all agents follow the same `AGENTS.md` rules and write to the same memory pipeline. The memory system is agent-agnostic by design: it uses plain markdown files and shell scripts, not any vendor-specific API.

---

## Day-to-Day Quick Reference

### Start of session
```bash
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
# Read memory/current.md and memory/inbox/ for context
```

### Record a decision or outcome
```bash
./scripts/memory_add.sh "title" "summary of what happened" "tag1,tag2"
git add memory/inbox
git commit -m "memory(add): title"
```

### After merging PRs upstream
```bash
git submodule update --remote repos/<name>
git add repos/<name>
git commit -m "chore(sync): bump <name> to <short-sha>"
```

### End of day (compact if inbox is large)
```bash
./scripts/memory_compact.sh
git add memory
git commit -m "memory(compact): end-of-day <date>"
git push
```

---

## Architecture Summary

```
Engineer A (Claude Code)          Engineer B (Codex)
        |                                |
        v                                v
  memory/inbox/                    memory/inbox/
  (append entry)                   (append entry)
        |                                |
        +--- no conflicts, unique filenames ---+
                         |
                         v
                 git push / pull
                         |
                         v
              memory_compact.sh (one operator)
                         |
              +----------+-----------+
              |          |           |
              v          v           v
         compactions/ current.md  archive/

              Submodule pointer bumps:
              repos/noetl  --> SHA from merged PR
              repos/ops    --> SHA from merged PR
                         |
                         v
                 ai-meta commit
           "chore(sync): bump noetl, ops"
```

---

## Checklist: Is Your Team Ready?

- [ ] Every engineer has `ai-meta` cloned with submodules initialized.
- [ ] `AGENTS.md` is read and understood by all team members.
- [ ] Each AI agent has its profile in `agents/` and follows the same rules.
- [ ] A compaction schedule is agreed upon (who compacts, how often).
- [ ] Sync note template (`sync/TEMPLATE.md`) is used for every multi-repo change.
- [ ] `memory/current.md` is curated at least monthly.
- [ ] No secrets, tokens, or credentials are ever committed (repo is public).
