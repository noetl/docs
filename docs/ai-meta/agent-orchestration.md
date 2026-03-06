---
sidebar_position: 7
title: Agent Orchestration with NoETL
description: Using NoETL as a registry and orchestrator for AI agents
---

# Agent Orchestration with NoETL

NoETL can serve as both a **registry** and **orchestrator** for AI agents, where each agent is defined as a NoETL playbook. This page explains why the mapping is natural, what it looks like in practice, and what needs to be built.

---

## Why NoETL Maps to Agent Orchestration

NoETL already has the primitives that multi-agent orchestration requires:

| NoETL Primitive | Agent Orchestration Equivalent |
|---|---|
| **Playbook** | Agent definition (instructions, tools, constraints) |
| **Steps with tools** (http, python, container) | Agent tool calls (Bash, Read, Write, API calls) |
| **Iterator / loops** | Multi-turn agent reasoning loops |
| **NATS messaging** | Inter-agent communication |
| **Server dispatch / Worker execution** | Registry (server knows agents) / Runtime (worker runs them) |
| **render_context / variables** | Agent context and memory injection |
| **Credential caching / keychain** | Agent authentication for external services |
| **Nested playbooks** | Agent-to-agent delegation |
| **Conditionals** | Branching based on agent results |

---

## What an Agent Registry Needs

A minimal agent registry provides five capabilities:

1. **Registration** — declare that an agent exists, what it does, what tools it has
2. **Discovery** — find agents by capability or name
3. **Invocation** — start an agent with a goal and context
4. **State tracking** — know if an agent is running, idle, succeeded, or failed
5. **Communication** — agents exchange results or hand off work

NoETL's server already handles capabilities 1 through 4 for playbooks. NATS provides capability 5.

### How NoETL Covers Each

**Registration:** Every playbook deployed to the server is registered. Adding `metadata.agent: true` and `metadata.capabilities` to agent playbooks makes them discoverable as agents specifically.

**Discovery:** The server tracks all deployed playbooks. Extending the query API to filter by metadata (e.g., "find agents with capability `code-review`") enables agent discovery.

**Invocation:** `noetl exec <playbook> --set key=value` already starts a playbook with input parameters. An agent invocation is the same call.

**State tracking:** `noetl status` shows running, completed, and failed executions. Agent status is playbook execution status.

**Communication:** NATS subjects allow playbooks to publish results and subscribe to each other's outputs. A parent playbook can aggregate results from child agent playbooks.

---

## Agent-as-Playbook: What It Looks Like

### A Single Agent Playbook

An agent playbook wraps AI reasoning (via the Claude Agent SDK) into a NoETL step:

```yaml
kind: playbook
name: code-reviewer
description: Reviews pull requests using Claude
metadata:
  agent: true
  capabilities:
    - code-review
    - security-audit
  model: claude-sonnet

input:
  repo: string
  pr_number: integer

steps:
  - name: fetch-pr-diff
    tool: http
    action: GET
    url: "https://api.github.com/repos/{{ input.repo }}/pulls/{{ input.pr_number }}"
    headers:
      Authorization: "Bearer {{ credentials.github_token }}"

  - name: analyze-code
    tool: python
    script: |
      from anthropic_agent_sdk import query

      review = await query(
          prompt=f"Review this PR diff for bugs and security issues:\n{fetch_pr_diff.output.diff}",
          model="claude-sonnet-4-20250514",
          system="You are a senior code reviewer. Be concise and actionable."
      )
      return {"approved": review.approved, "comments": review.comments}

  - name: post-review
    tool: http
    action: POST
    url: "https://api.github.com/repos/{{ input.repo }}/pulls/{{ input.pr_number }}/reviews"
    headers:
      Authorization: "Bearer {{ credentials.github_token }}"
    body:
      event: "{{ 'APPROVE' if analyze_code.output.approved else 'REQUEST_CHANGES' }}"
      body: "{{ analyze_code.output.comments }}"
```

The agent is a regular playbook. The AI reasoning happens in a `python` step that calls the Claude Agent SDK. Everything else (HTTP calls, credential management, error handling) uses existing NoETL tools.

### Multi-Agent Orchestration via Parent Playbooks

A parent playbook coordinates multiple agent-playbooks, the same way NoETL already coordinates nested playbooks:

```yaml
kind: playbook
name: release-coordinator
description: Orchestrates a full release cycle using specialized agents
metadata:
  agent: true
  capabilities:
    - release-management

input:
  repo: string
  pr_number: integer
  target_env: string

steps:
  - name: review-code
    playbook: code-reviewer
    input:
      repo: "{{ input.repo }}"
      pr_number: "{{ input.pr_number }}"

  - name: run-tests
    playbook: test-runner
    input:
      repo: "{{ input.repo }}"
      branch: main

  - name: check-results
    tool: python
    script: |
      approved = review_code.output.approved
      tests_passed = run_tests.output.all_passed
      return {"ready": approved and tests_passed}

  - name: deploy
    playbook: deployer
    condition: "{{ check_results.output.ready }}"
    input:
      repo: "{{ input.repo }}"
      target: "{{ input.target_env }}"

  - name: notify
    tool: http
    action: POST
    url: "{{ credentials.slack_webhook }}"
    body:
      text: "Release {{ input.repo }} PR #{{ input.pr_number }} → {{ input.target_env }}: {{ 'deployed' if check_results.output.ready else 'blocked' }}"
```

The agents do not need to know about each other. The parent playbook handles sequencing, conditionals, and result aggregation. This is standard NoETL orchestration.

---

## Architecture

```
                    ┌─────────────────────────┐
                    │     NoETL Server         │
                    │  (Agent Registry)        │
                    │                          │
                    │  Deployed playbooks:     │
                    │  - code-reviewer  [agent]│
                    │  - test-runner    [agent]│
                    │  - deployer       [agent]│
                    │  - release-coord  [agent]│
                    └──────────┬──────────────┘
                               │ dispatch via NATS
                    ┌──────────▼──────────────┐
                    │     NoETL Workers        │
                    │  (Agent Runtime)         │
                    │                          │
                    │  Execute agent playbooks │
                    │  Call ADK/LangChain SDKs │
                    │  Run tools (http, py..)  │
                    └──────────┬──────────────┘
                               │ results via NATS
                    ┌──────────▼──────────────┐
                    │     NATS                 │
                    │  (Agent Message Bus)     │
                    │                          │
                    │  Inter-agent results     │
                    │  Status updates          │
                    │  Event streaming         │
                    └─────────────────────────┘
```

### How It Maps to Existing NoETL Components

| Component | Current Role | Agent Role |
|---|---|---|
| **Server** | Receives playbook executions, dispatches to workers | Agent registry: knows all agents, their capabilities, dispatches invocations |
| **Worker** | Executes playbook steps using tools | Agent runtime: executes agent logic including LLM calls |
| **NATS** | Message transport between server and workers | Agent bus: inter-agent communication, status, results |
| **Gateway** | External API (GraphQL/REST) | Agent API: external systems invoke agents via HTTP |
| **PostgreSQL** | Execution state, history | Agent state: execution history, audit trail |
| **Credentials/Keychain** | API keys for tools | Agent auth: LLM API keys, service credentials |

---

## What Needs to Be Built

| Component | Exists Today | What Is Needed |
|---|---|---|
| Playbook execution engine | Yes | No change needed |
| Agent metadata in playbooks | Yes | Implemented via `metadata.agent` and `metadata.capabilities` extraction on catalog registration |
| Discovery by capability | Yes | Implemented via `/catalog/list` filters and `/catalog/agents/list` endpoint |
| ADK/LangChain bridge tool | Yes (initial) | Implemented as `tool.kind: agent` with `framework: adk|langchain|custom`, entrypoint loading, and runtime invocation |
| Agent memory read/write | No | Steps that read/write to ai-meta `memory/` or NATS KV store |
| Inter-agent messaging | Partially (NATS exists) | Standardize a message schema for agent-to-agent results |
| Agent status in dashboard | Partially (`noetl status`) | Extend to show agent-specific metadata and capabilities |

### The Critical New Piece: `tool.kind: agent`

NoETL now has a first-class agent runtime bridge. Instead of writing raw Python to call SDKs directly, an agent step can be declared like:

```yaml
- step: analyze
  tool:
    kind: agent
    framework: langchain
    entrypoint: "agents.reviewer:build_chain"
    entrypoint_mode: factory
    payload:
      goal: "Review this diff: {{ fetch_pr.output.diff }}"
```

For ADK-style runners, pass keyword payload fields such as `user_id`, `session_id`, and `new_message`; the runtime bridge maps payload keys to the callable signature and materializes async generator event streams into step output.

---

## How This Connects to ai-meta

The `ai-meta` repository provides the **team coordination layer** that sits above the agent runtime:

- **Agent playbook definitions** live in their respective repos (e.g., `repos/noetl`, `repos/ops`)
- **Cross-agent orchestration docs** live in `ai-meta/playbooks/` and `ai-meta/sync/`
- **Agent memory** is shared through `ai-meta/memory/` (Git-tracked, cross-session)
- **Submodule pointers** pin the exact version of each agent playbook deployed

```
ai-meta (coordination + memory)
    │
    ├── memory/          shared agent knowledge
    ├── sync/            cross-agent change tracking
    ├── playbooks/       orchestration runbooks
    │
    └── repos/
        ├── noetl/       agent execution engine + core agent playbooks
        ├── ops/         deployment agent playbooks
        ├── server/      registry (server component)
        └── worker/      runtime (worker component)
```

---

## Getting Started

To experiment with the agent-as-playbook pattern today:

1. **Write an agent playbook** with `tool.kind: agent` and `framework: adk|langchain|custom`
2. **Deploy it** to your NoETL server like any other playbook
3. **Invoke it** with `noetl exec <agent-playbook> --set goal="..."`
4. **Orchestrate multiple agents** by writing a parent playbook that calls agent playbooks as nested steps
5. **Track results** with `noetl status` and persist decisions to `ai-meta/memory/`

The remaining gaps are memory/state conventions and a standardized inter-agent message schema; agent execution and discovery primitives are now available in the runtime/server.
