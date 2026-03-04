NoETL/AI-META repo for NoETL ecosystem AI-assisted development ops: https://github.com/noetl/ai-meta/tree/main

**How it works:** it includes all participating repos as **git submodules**, so we can track versions together and apply/validate cross-repo changes in one place.

**Why:** NoETL is becoming an ecosystem (server/worker/CLI, gateways, plugins, docs, examples). This repo is where we keep shared standards \+ automation.

**What it will handle:**

* Cross-repo planning \+ multi-repo refactors

* Shared conventions (structure, PR/release process, docs patterns)

* DevOps automation (CI/CD patterns, tagging/baking/publishing, checks)

* AI-driven workflows to reduce repetitive work and speed up maintenance

Here’s what’s in noetl/ai-meta today, what each folder/file is for, and how the “inbox → compaction → current state” memory system works.

## **Top-level layout (what is for what)**

* **repos/** — the *actual NoETL ecosystem codebases* checked in as **git submodules**, pinned to specific SHAs. This is how ai-meta “tracks the world” and coordinates multi-repo changes and releases. The repos/ directory currently includes submodules like server, worker, gateway, cli, noetl, docs, ops, tools, etc., each pinned to a commit SHA. 

* **AGENTS.md** — global rules for AI/dev work in this repo: keep it public-safe (no secrets), don’t store product code here, memory must be append-only, don’t rewrite main, etc. 

* **agents/** — agent-specific “working profiles” (right now: codex.md, claude.md) that tell an AI assistant how to operate with strict repo boundaries: changes happen inside submodules; ai-meta only holds pointers \+ orchestration docs. 

* **memory/** — the Git-tracked long-memory store (details below). 

* **scripts/** — executable helpers (today: memory\_add.sh, memory\_compact.sh) to manage the memory workflow. 

* **playbooks/** — human-readable checklists for common orchestration routines (e.g., “cross repo change”, “memory compaction”). 

* **sync/** — small “sync note” docs that capture the *what changed across repos*, PR links, resulting SHAs, and follow-ups. 

* **README.md / .gitmodules** — explains the repo purpose and how to init/update submodules. 

---

## **The AI “long memory” system (inbox, compactions, current, timeline)**

The memory system is intentionally Git-native: raw notes land in an **inbox**, then you periodically **compact** them into a summarized artifact and update a **current working state**.

### **memory/**

###  **structure**

Inside memory/ you have: 

* **memory/inbox/** — *raw, un-compacted* entries (new facts, decisions, TODOs, cross-repo notes). Think “append-only journal drops”. 

* **memory/compactions/** — periodic *aggregations* (summaries) generated from inbox entries. 

* **memory/archive/** — where processed inbox entries are moved after compaction (keeps inbox clean without losing history). 

* **memory/current.md** — the compact “active memory” file: what matters *right now* \+ pointers to the latest compactions. 

* **memory/timeline.md** — a chronological index so you can scan history by month and see when compactions happened. 

* **memory/README.md** — rules \+ commands for the workflow. 

### **How “inbox → compaction → current” works internally**

#### **1\) Adding a memory entry (“inbox write path”)**

run:

./scripts/memory\_compact.sh

What it does (mechanically): 

* Finds all \*.md files under memory/inbox/ (sorted).

* Writes a new compaction file named like:

   memory/compactions/\<timestamp\>.md

* In that compaction file it:

  * Lists **Source Entries** (paths \+ titles)

  * Creates **Consolidated Notes** sections for each entry

* Updates **memory/current.md** by appending a new “Compaction ” section that points to the compaction file and lists which titles were compacted.

* Updates **memory/timeline.md** under the month bucket (e.g. \#\# 2026-03) with a one-line entry referencing the compaction.

* Moves the original inbox entries into **memory/archive/...** preserving their relative paths.

You can see an example compaction output here (it points back to the single source inbox entry and summarizes it): 

#### **3\) Commit chain (why it’s “Git long-memory”)**

The repo enforces a commit convention so the memory becomes durable through Git history:

* memory(add): \<topic\> for raw inbox entries

* memory(compact): \<date/scope\> for compaction runs 

This makes “memory” auditable, reviewable, and reproducible like code.

---

## **How it all ties back to cross-repo development ops**

* repos/\* are the **sources of truth** for code (each repo is independent). AI work happens *inside* the correct submodule. 

* ai-meta is where you:

  1. coordinate “what repos are involved”

  2. record decisions/notes (memory)

  3. store checklists (playbooks)

  4. bump submodule pointers once upstream PRs are merged 

* sync/ is the lightweight “release note for engineers”: which repos changed, PR links, SHAs, and follow-ups. 

## **Day-to-day workflow (how to use ai-meta)**

ai-meta is the coordination repo for the NoETL ecosystem. It contains:

* **repos/**: all NoETL repos as **git submodules** (pinned SHAs)

* **memory/**: a Git-tracked long-memory system (inbox → compaction → current)

* **sync/**: cross-repo “what changed” notes (PR links, SHAs, follow-ups)

* **playbooks/** \+ **scripts/**: repeatable checklists and helpers

### **1\) Clone \+ initialize submodules**

git clone https://github.com/noetl/ai-meta.git

cd ai-meta

\# initialize and fetch all submodules

git submodule update \--init \--recursive

\# later, to pull latest submodule commits from their remotes (if you want)

git submodule update \--remote \--recursive

**How it works:** ai-meta tracks each ecosystem repo as a submodule, so you can coordinate multi-repo changes in one workspace. The “state” of the ecosystem is the set of SHAs currently pinned in repos/\*.

### **2\) Make changes in the right repo (inside submodules)**

When you need to implement a change, do it in the relevant submodule:

cd repos/noetl-server   \# example

git checkout \-b feat/something

\# ... implement change ...

git commit \-am "..."

git push \-u origin feat/something

\# open PR in that repo

Repeat for any other repo(s) involved.

**Rule of thumb:** code changes happen in the submodule repos. ai-meta stores coordination artifacts and updates the submodule pointers after PRs are merged.

### **3\) Update submodule pointers in** 

### **ai-meta**

###  **after merges**

Once PRs are merged upstream, update the pinned SHAs:

\# from ai-meta root

git submodule update \--remote \--recursive

git status

git diff

Then commit the updated submodule pointers:

git add repos/\*

git commit \-m "chore(sync): bump submodules for \<topic\>"

git push

### **4\) Record a cross-repo sync note (**

### **sync/**

### **)**

When you complete a multi-repo change, add a short sync note that answers:

* What changed (summary)

* Which repos were touched

* PR links

* Resulting SHAs/tags

* Follow-ups / known risks

Create a new file like:

sync/YYYY/MM/YYYYMMDD-\<topic\>.md

Keep it short, but concrete (links \+ SHAs).

### **5\) Use memory as your long-term operating log**

Memory is a Git-native “working memory” system:

* **memory/inbox/** \= raw notes (append-only drops)

* **memory/compactions/** \= periodic aggregations/summaries

* **memory/current.md** \= what matters now

* **memory/timeline.md** \= chronological index

* **memory/archive/** \= processed entries moved out of inbox

#### **Add a memory entry**

./scripts/memory\_add.sh "\<title\>" "\<summary\>" "\<tags\>"

Example:

./scripts/memory\_add.sh \\

  "Gateway release workflow unified" \\

  "Aligned tagging+bake publishing steps across gateway/server/worker; follow-up: add SBOM." \\

  "release,gateway,ci"

Commit it:

git add memory/inbox

git commit \-m "memory(add): gateway release workflow unified"

git push

#### **Compact memory (aggregation)**

Run periodically (daily/weekly, or after big changes):

./scripts/memory\_compact.sh

This will:

* create a compaction file in memory/compactions/

* update memory/current.md and memory/timeline.md

* move compacted inbox entries to memory/archive/

Commit it:

git add memory

git commit \-m "memory(compact): \<scope\>"

git push

### **6\) “One workflow” for a typical multi-repo change**

1. Identify which repos are involved (submodules under repos/)

2. Implement changes in each repo (PRs in the submodule repos)

3. After merges, bump the submodule SHAs in ai-meta

4. Write a sync/ note with PR links \+ resulting SHAs

5. Add a memory entry capturing decisions \+ follow-ups

6. Compact memory periodically

