# How AI Agents Work (Instructions, Memory, Aggregation) — with the NoETL `ai-meta` Example

This lesson explains how modern AI “agents” (Codex, Claude, and other LLM-powered assistants) work internally when they **plan and execute chains of tasks** in real engineering projects. We’ll use the **NoETL ecosystem meta-repo** (`noetl/ai-meta`) as a concrete example of how to structure an agent-friendly project.

> Example repo: https://github.com/noetl/ai-meta

---

## 1) What an AI Agent is (vs. just “chatting with an LLM”)

A plain LLM chat is typically:

- You ask → model answers
- No durable state (beyond the current conversation)
- No tools, no execution environment, no continuity

An **AI agent** is typically a *system* built around an LLM that adds:

- **Instructions / policy** (what it must do, what it must not do)
- **Tools** (git, filesystem, CI, APIs, shells, browsers, etc.)
- **Memory** (short-term context + long-term storage)
- **Planning / orchestration** (break work into steps, execute in order)
- **Feedback loops** (evaluate results, retry, compact, update state)

---

## 2) The core internal loop (plan → act → observe → update)


## 2.1 How agents make decisions (if/then/else) — and what the LLM is actually doing

People often describe agents as if the LLM itself is executing explicit `if/else` logic internally. In practice:

- The **agent program** (outside the LLM) executes real `if/then/else` branching.
- The **LLM** generates text (plans, code, summaries) by **predicting the next token** given the provided context.

### A) Where the real `if/then/else` lives: the agent controller

An agent is usually a controller loop that looks like this:

```
while not done:
  context = assemble_context(goal, memory, repo_state, tool_outputs)
  plan = LLM(context)

  for step in plan:
    result = run_tool(step)
    if result.failed:
       repair_or_retry()
       break

  if success_criteria_met():
     done = True
  else:
     update_memory_and_continue()
```

Those `if result.failed` / `if success_criteria_met` checks are explicit program logic.  
The LLM *advises* (plans, writes patches), but the controller decides what happens next.

### B) What the LLM is doing: pattern completion, not symbolic branching

Modern LLMs (transformers) work roughly like this:

1. Convert input text into tokens
2. Pass tokens through many layers that compute attention-based representations
3. Output a probability distribution over the next token
4. Sample/select the next token
5. Repeat until completion

So when an LLM “decides” something, it is choosing tokens that best match patterns it learned from training data **and** the constraints in the prompt.

This can *look* like reasoning, but it is best understood as:

- **statistical pattern matching + constrained generation**
- guided by **instructions and evidence** present in the context window

### C) How agents turn text into decisions: “structured prompts + structured parsing”

To make LLM output actionable, agents commonly use:

- **Templates** (explicit output formats): JSON, YAML, bullet plans, checklists
- **Parsing** (turn text into structured objects)
- **Validation** (schema checks, required fields, allowed actions)
- **Policy gates** (block forbidden operations)

Example: ask the LLM to output steps like:

- action: read_file / run_tests / edit_file
- target: path
- expected: outcome

Then the controller parses that into executable steps.

### D) Decision sources (what influences the branch)

When the controller chooses a branch, it usually uses:

- **Tool results** (tests passed/failed, build errors, API responses)
- **Repo rules** (AGENTS.md forbids secrets or rewriting history)
- **State** (what’s already done in this session)
- **Memory** (prior decisions, known pitfalls, current priorities)
- **Cost/time constraints** (limit retries, limit broad searches)

So the agent is “intelligent” because:
- it repeatedly gathers evidence (tools),
- applies constraints (instructions),
- and adapts its plan (LLM + controller loop).

### E) Example: a concrete branch in NoETL `ai-meta`

Scenario: updating a workflow across submodules.

- If CI fails in `repos/noetl-gateway` → prioritize fixing gateway workflow first.
- Else if server workflow differs → align server next.
- Else → write sync note and bump submodule SHAs.

The LLM can propose these branches, but the controller makes the final call based on actual CI outputs.


Most practical agents run a loop like:

```
┌────────────────────────────────────────────────────────────┐
│  USER GOAL                                                  │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  1) INSTRUCTIONS / POLICY                                   │
│     - system rules, repo rules, safety rules                │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  2) CONTEXT ASSEMBLY                                        │
│     - task prompt + relevant files + retrieved memories      │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  3) PLANNER                                                 │
│     - break goal into steps                                 │
│     - select tools                                          │
│     - decide what to read/write                             │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  4) EXECUTION                                                │
│     - call tools (git, shell, tests, APIs)                   │
│     - write files / commit changes                           │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  5) OBSERVE + EVALUATE                                      │
│     - read tool outputs                                     │
│     - verify success criteria                               │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│  6) MEMORY UPDATE                                           │
│     - store decisions / results                              │
│     - compact/summarize as needed                            │
└────────────────────────────────────────────────────────────┘
```

This loop is why agents can “keep going” on complex tasks: they continually rebuild context, execute actions, and record outcomes.

---

## 3) The mechanisms agents rely on (the “full list” you should know)

Below is a practical checklist of mechanisms used by agentic systems in real projects:

### A. Instruction layers (the agent’s “constitution”)

1. **System instructions** (highest priority): safety rules, tool constraints  
2. **Repo-level rules**: “how to work in *this* repo”  
3. **Task-level instructions**: your immediate goal / acceptance criteria  
4. **Conventions**: style guides, naming, commit format, directory layout  
5. **Guardrails**: “don’t touch X”, “never store secrets”, “don’t rewrite history”

In `ai-meta`, `AGENTS.md` is the repo-level “constitution” for AI work.

---

### B. Context assembly (short-term memory)

Agents must fit work context into a limited prompt window. Context assembly is the **packaging step** that decides:

- *what* to include (files, notes, diffs, logs),
- *how much* to include (full text vs. excerpts),
- and *in what order* (rules first, then current state, then evidence).

Think of it as building a “mini-briefing” for the LLM, every time the agent asks it to plan or write.

#### B.1 The token budget problem (why context assembly exists)

LLMs have a finite **context window** (a maximum number of tokens they can “see” at once). Real projects exceed that immediately:

- thousands of files,
- long issue histories,
- many PRs,
- months of decisions,
- large logs.

So agents need a deterministic method to compress the world into a small set of relevant inputs.

#### B.2 A practical context assembly recipe (what agents actually do)

1) **Always include hard guardrails (highest priority)**
   - `AGENTS.md` (repo rules)
   - any “do not” lists (secrets, forbidden paths, no history rewrites)

2) **Include the current snapshot**
   - `memory/current.md` (what matters now)

3) **Retrieve task-relevant evidence**
   - the few files that define the behavior you’re changing
   - recent sync notes for cross-repo impact
   - the latest compaction for relevant decisions

4) **Include execution feedback**
   - failing test output (trimmed to the key error)
   - lints/CI logs (only the relevant sections)
   - command outputs (only what’s needed to reason)

5) **Summarize and pointerize**
   - turn large bodies into short summaries
   - keep stable references to originals via paths and links

#### B.3 The four tactics — expanded in detail

**1) Load the minimum necessary files**
- Use *path heuristics*: “CI change → `.github/workflows/**`”, “DSL change → `docs/reference/**`”
- Use *dependency hints*: read the config file plus the code that consumes it
- Prefer *entry points* over internals first (e.g., “workflow file” before “helper modules”)

**2) Add short summaries instead of full histories**
- Summarize a PR thread into: *intent, decision, outcome, follow-ups*
- Summarize a long doc into: *contract, constraints, examples*
- Summaries are “lossy compression” that preserves what the agent needs to act.

**3) Prefer pointers (links/paths) over copying content**
- Include `repos/noetl-gateway/.github/workflows/release.yml` as a **path pointer**
- Quote only the 10–30 lines that matter (the snippet that is being changed)
- Pointers keep context small while remaining auditable and navigable.

**4) Rehydrate context via search and retrieval**
- If the plan needs more detail, the agent fetches more context:
  - `rg "tag-and-bake" repos/noetl-gateway -n`
  - search memory for “publish workflow”
  - read the latest sync note for “gateway release”
- This is a *loop*: retrieve → pack → ask LLM → act → observe → retrieve more.

#### B.4 A context assembly “packing order” that works well

```
1) Rules (AGENTS.md)
2) Current snapshot (memory/current.md)
3) Retrieved evidence (files/snippets/sync/compactions)
4) Tool outputs (errors, diffs, tests)
5) Task prompt (goal + acceptance criteria)
```

This order prevents the LLM from ignoring rules or missing “what matters now”.

#### B.5 Example: context assembly for a cross-repo workflow change

Goal: “Unify tag+bake publish across gateway and server.”

The agent would pack something like:

- `AGENTS.md` (constraints)
- `memory/current.md` (active priorities + known issues)
- `sync/2026/03/20260303-...` (latest cross-repo note, if any)
- snippet from `repos/noetl-gateway/.github/workflows/...`
- snippet from `repos/noetl-server/.github/workflows/...`
- last CI failure excerpt (if applicable)

Then it calls the LLM to plan edits, executes them, and repeats as needed.

---

### C. Long memory (durable state)

Long memory is how an agent “remembers” beyond a single session:

- **Append-only journal entries** (what happened, decisions, outcomes)
- **Indexes and timelines** (so you can find things later)
- **Compactions** (summaries of many raw entries)
- **Current working state** (“what matters now”)

`ai-meta` implements this as a Git-tracked memory store in `memory/`.

---

### D. Aggregation / compaction (keeping memory useful)

If you keep everything forever in raw form, memory becomes noisy and unusable.  
So agents use **aggregation**:

- **Compaction**: summarize a batch of raw notes into a shorter artifact
- **Promotion**: move important facts into “current state”
- **Archival**: move processed raw entries out of the inbox

This is the exact flow in `ai-meta`:

- `memory/inbox/` → `memory/compactions/` → updates `memory/current.md` and `memory/timeline.md` → move to `memory/archive/`

---

### E. Retrieval (finding the right facts at the right time)

Common retrieval strategies:

- **Path-based retrieval**: “read `AGENTS.md` first”
- **Keyword search**: search in repo for terms
- **Tag-based retrieval**: memory entries tagged by topic
- **Recency-based retrieval**: “latest compaction first”
- **Semantic retrieval** (optional): embeddings/vector search across notes

Even without embeddings, good *structure and naming* enable effective retrieval.


### E.1 Retrieval-Augmented Generation (RAG) — how it fits here

**RAG** is a pattern where the agent *retrieves* relevant external knowledge (documents, code, tickets, runbooks, memory entries) and **injects it into the model’s context** before asking the LLM to plan or generate outputs.

RAG matters because LLMs do **not** reliably “remember” your repo or history unless you provide it *in the prompt window*. RAG is how agents turn a large, long-lived project into a set of small, relevant snippets the LLM can use right now.

In an `ai-meta`-style workflow, RAG typically pulls from:

- **Repo rules**: `AGENTS.md`, `agents/*.md`
- **Current state**: `memory/current.md`
- **Latest compactions**: `memory/compactions/<latest>.md`
- **Recent sync notes**: `sync/YYYY/MM/*.md`
- **Target code**: files inside the relevant submodule(s) under `repos/`

#### RAG pipeline (minimal, practical form)

```
Query (goal) → Retrieve candidates → Rank/filter → Pack into context → LLM call
```

Where retrieval and ranking can be:

- **Lexical**: grep/ripgrep, filename/path heuristics, commit message search
- **Structural**: “always include current.md + AGENTS.md”
- **Recency-based**: “prefer newest compaction + newest sync notes”
- **Semantic** (optional): embeddings / vector search over memory and docs

#### Why `ai-meta` is a good RAG substrate

Good RAG depends on **high-signal artifacts**. `ai-meta` creates those intentionally:

- **Inbox entries** are short, timestamped, and tagged → easy to retrieve.
- **Compactions** summarize many entries → fewer tokens, higher density.
- **Current** is an always-fresh snapshot → the “working memory”.
- **Sync notes** are scoped to cross-repo changes → targeted context.
- **Commit message conventions** act as searchable “labels” for state transitions.

#### RAG in practice: one concrete example

Goal: “Update gateway publish workflow; keep compatibility with server and docs.”

RAG inputs the agent would pack into context:

1) `AGENTS.md` (guardrails)  
2) `memory/current.md` (what’s active right now)  
3) latest `memory/compactions/...` (recent decisions)  
4) most recent `sync/...` note referencing publish/tag/bake  
5) the relevant CI files inside `repos/noetl-gateway/.github/workflows/...`

Then the LLM plans, and tools execute the plan.

---

---

### F. Planning, tool use, and feedback loops

Key patterns:

- **Decomposition**: break a goal into small verifiable steps
- **Tool selection**: choose git/tests/scripts/API calls
- **Checkpoints**: run tests, lint, validate outputs
- **Retry / repair**: if something fails, adjust and rerun
- **Determinism**: prefer reproducible commands and pinned SHAs

`ai-meta` explicitly aims for determinism by pinning submodule SHAs.

---

## 4) Why folder structure and naming conventions matter (a lot)

Agents are limited by:

- context window size
- time/attention (they must choose what to read)
- retrieval quality

So the project must be **agent-readable**.

### Folder structure helps agents by:

- Creating **semantic “zones”** (“docs go here”, “memory goes here”, “scripts go here”)
- Making retrieval cheap (“look in `memory/current.md` for current state”)
- Enabling safe behavior (“product code doesn’t live here”)

### Naming conventions help agents by:

- Encoding meaning in filenames: `YYYYMMDD-topic.md`
- Ensuring stable references: scripts and docs don’t move constantly
- Improving search and sorting (lexicographic order matches chronology)

### “Small, consistent files” beat “one huge wiki”

Agents do better with:

- many small files with tight scope  
- predictable, repeated templates  
- an index (`timeline.md`) + a current snapshot (`current.md`)

---

## 5) NoETL `ai-meta` as an “agent-native” coordination repo

`ai-meta` is designed as a control plane for engineering work across many repos.

### The role of each top-level folder (how it works)

```
ai-meta/
  AGENTS.md                 # global AI rules (public/safe, no product code)
  agents/                   # per-agent guidance (Codex, Claude)
  repos/                    # Git submodules for all NoETL repos (pinned SHAs)
  sync/                     # cross-repo sync notes (what changed, PR links, SHAs)
  playbooks/                # repeatable checklists (how to do X)
  scripts/                  # helpers to manage memory + automation
  memory/                   # long-memory store (inbox → compactions → current)
```

### Why git submodules are valuable for agents

Submodules give you:

- a *single workspace* spanning many repos
- a deterministic “ecosystem snapshot” (exact SHAs)
- a safe boundary: code changes happen **inside** the correct submodule repo

An agent can coordinate a multi-repo change like:

1) implement in each repo (submodule)  
2) merge PRs upstream  
3) bump submodule pointers in `ai-meta` with one coordination commit  
4) record the sync note + memory entry

---

## 6) Commit messages as agent-readable instructions

In agent workflows, commit messages become part of the “instruction layer” because they:

- summarize intent (“what did we do and why?”)
- label state transitions (“memory(add)”, “memory(compact)”, “chore(sync)”)
- provide an auditable chain agents can rehydrate later

### Example patterns used in `ai-meta`

- `memory(add): <title>`
- `memory(compact): <scope>`
- `chore(sync): bump <repo1>, <repo2> to merged SHAs`
- `docs(agents): update cross-repo workflow guidance`

These are not just for humans — they also create **machine-retrievable signals** that an agent can search and follow.

---

## 7) The `ai-meta` long-memory pipeline (inbox → compaction → current)

### Add memory (raw entry)

You capture a fact/decision with a consistent template:

```
./scripts/memory_add.sh "<title>" "<summary>" "<tags>"
git add memory
git commit -m "memory(add): <title>"
```

This creates a timestamped entry under `memory/inbox/YYYY/MM/`.

### Compact memory (aggregate and clean up)

```
./scripts/memory_compact.sh
git add memory
git commit -m "memory(compact): <scope>"
```

Compaction does three important things:

1) Generates a **summary file** in `memory/compactions/`  
2) Updates **`memory/current.md`** and **`memory/timeline.md`**  
3) Moves processed entries to **`memory/archive/`**

This keeps the “active brain” small while preserving a complete history.

---

## 8) Codex + Claude together (a practical division of labor)

You can use multiple agents/models productively if each has a clear role:

- **Codex-style agent**: strong at code edits, refactors, test-driven changes, repo navigation  
- **Claude-style agent**: strong at summarization, documentation, reasoning about architecture, writing playbooks

In `ai-meta`, this division is natural:

- submodule code changes → Codex (in the relevant repo)
- orchestration docs, memory compaction, sync notes → Claude or Codex (both work)

What matters is that both follow the **same instruction layer** (`AGENTS.md`) and the **same memory pipeline**.

---

## 9) Text diagrams: an AI agent architecture for NoETL ecosystem work

### A) “Control plane” view (where `ai-meta` fits)

```
                ┌──────────────────────────────────────────┐
                │                ai-meta                    │
                │  - rules (AGENTS.md)                      │
User Goal  ───▶  │  - memory (current/timeline/compactions)  │
                │  - playbooks + sync notes                 │
                │  - submodule pointers (ecosystem snapshot) │
                └───────────────┬───────────────────────────┘
                                │
                                ▼
                     ┌────────────────────┐
                     │ repos/* (submodules)│
                     │  noetl, server, ui, │
                     │  gateway, worker... │
                     └─────────┬───────────┘
                               │
                               ▼
                       PRs / merges / tags
```

### B) “Agent loop” view (how it executes cross-repo tasks)

```
[Read AGENTS.md] → [Load current memory] → [Plan steps]
        ↓                    ↓                 ↓
   [Select repo(s)] → [Edit in submodule] → [Run tests]
        ↓                    ↓                 ↓
    [Open PRs] → [After merge, bump SHAs] → [Write sync note]
        ↓
  [Add memory entry] → [Compact periodically] → [Update current state]
```

---

## 10) A worked example: orchestrating a NoETL ecosystem change

**Goal:** “Update release tagging+bake workflow across gateway + server + docs”

Agent plan:

1. Identify repos involved (`repos/noetl-gateway`, `repos/noetl-server`, `repos/docs`)
2. Make code changes inside each submodule, open PRs
3. After merges:
   - update submodule pointers in `ai-meta`
   - commit: `chore(sync): bump gateway, server, docs to merged SHAs`
4. Add a sync note under `sync/YYYY/MM/`
5. Add memory entry:
   - title: “release workflow unified”
   - tags: `release,ci,distribution`
6. Run compaction weekly to keep `current.md` small

This is how you get **repeatable**, **auditable**, **multi-repo** execution driven by AI agents.

---

## 11) Best practices for agent-friendly long-running projects

1. **One repo = one purpose**  
   `ai-meta` is coordination + memory, not product code.

2. **Make rules explicit**  
   Put repo-level constraints in `AGENTS.md` and keep it short and strict.

3. **Prefer append-only memory**  
   Don’t rewrite history; add new entries and compact.

4. **Use stable filenames and templates**  
   Timestamped entries + standard sections (“Summary”, “Actions”, “Repos”).

5. **Treat commits as structured signals**  
   A consistent commit grammar makes the project “queryable” by agents.

6. **Keep a current snapshot**  
   Always maintain `memory/current.md` as the “active brain” for new sessions.

---

## 12) Quick reference: what to tell contributors

- Start in `AGENTS.md`
- Work in submodules under `repos/`
- Record cross-repo outcomes in `sync/`
- Record decisions in `memory/inbox/`
- Compact regularly into `memory/compactions/` + update `memory/current.md`

---

### Optional homework (for your team)

1) Add a `sync/TEMPLATE.md` and enforce it in PR reviews  
2) Add a weekly “memory compaction” ritual  
3) Add tags that match your roadmap areas (dsl, gateway, ui, release, runtime, docs)  
4) Introduce semantic search later (optional) once file naming and templates are stable
