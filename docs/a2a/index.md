---
sidebar_position: 1
title: A2A Agent Mesh (signal-mesh)
description: A tiered A2A / ReAct agent mesh over an EHDB-shaped event log — what it is, what ships today, and what it deliberately does not do
---

# A2A Agent Mesh — `signal-mesh`

**signal-mesh** is a tiered **A2A / ReAct** agent mesh built over an
[EHDB](https://github.com/noetl/ehdb)-shaped event log. It reduces a very large
number of edge signals to **one number and one boolean**, and every intermediate
step — every `observe`, `reason`, `act` — is an event in a replayable log rather
than a hidden call.

It speaks the [**Agent2Agent (A2A) protocol**](https://a2a-protocol.org/latest/specification/),
so another system can discover an agent and ask it for work over a standard
surface.

:::info Status — MVP, flag-gated, not deployed
Three milestones are merged on `main`: **M1** (persistence), **M2** (A2A
transport), **M9** (operability). Together these are the project's own
"MVP cut" — the smallest slice where the thing is *real*: answers survive a
restart, and another system can discover and ask for one.

**Every capability is behind an environment flag and every flag is off by
default.** `signal-mesh` is a standalone crate; it is **not wired into any
NoETL production binary and is not deployed anywhere.** Read
[Scope and non-goals](#scope-and-non-goals) before drawing conclusions.
:::

## The problem

A mesh of thousands of devices emits thousands of signals. A dashboard can show
them; it cannot tell you whether the site is healthy. Reducing them needs
judgement at each level, and judgement that cannot be replayed cannot be
trusted — or debugged after an incident.

signal-mesh makes the reduction itself event-sourced: the same log prefix folds
to the same verdict, every time.

## Topology

Signals flow up through tiers, narrowing at each one:

| layer | role |
| :-- | :-- |
| **Edge** | thousands of devices, each emitting a signal class (temp, vibration, pressure, …) |
| **Collectors** | sharded by device / region; append signals to the log |
| **Tier 0** | raw ReAct agents — one per device or signal class (`observe → reason → act`) |
| **Tier 1** | specialized aggregators (site-health weighted mean, asset-risk max) |
| **Tier 2** | a synthesizer — a numeric definition-function over Tier 1 |
| **Verdict** | one number, one boolean |

The cascade runs **at a named watermark**, so a fold is over a defined prefix
rather than "whatever had arrived". That is what makes replay exact.

## Where A2A fits

Each agent publishes an **Agent Card**; other systems submit **Tasks** against
it. The implementation is grounded in the A2A specification (latest release
1.0.0) and is deliberate about three details that summaries commonly get wrong:

### The well-known path

```
GET /.well-known/agent-card.json
```

Registered as an RFC 8615 well-known URI in A2A v1.0. It was `agent.json` until
v0.3 — an implementation that still fetches the old name will not find the card.

### Eight Task states, and two of them are not failures

| state | |
| :-- | :-- |
| `submitted` | accepted, not started |
| `working` | in progress |
| `input-required` | ⚠ **interrupted — resumable, not terminal** |
| `auth-required` | ⚠ **interrupted — resumable, not terminal** |
| `completed` · `failed` · `canceled` · `rejected` | terminal |

The commonly-quoted five-state summary omits `input-required`, `auth-required`
and `rejected`. Treating the two interrupted states as failures is the single
most common way a dispatcher mis-implements A2A — a task that was merely waiting
for input gets discarded. The mesh's transport test fails if you do this.

### Version negotiation is on `Major.Minor`

The build speaks `1.0`; patch is excluded from negotiation, so forward
compatibility within the major line is accepted rather than refused.

## What ships on `main` today

All three slices are off unless the flag is set.

### M1 — persistence

```bash
NOETL_SIGNAL_MESH_STORE=ehdb    # anything else, including unset, means memory
```

Mesh events persist to a real EHDB `L0Engine` in their own dataset, with
idempotent appends and per-agent indexed prefix folds. Restart → re-fold →
identical digest.

:::warning The unsealed tail is inherited, not fixed
Two failure modes, and only one is free:

| failure | recovery | needs `checkpoint()`? |
| :-- | :-- | :-- |
| process died, disk intact | re-open the same root | no |
| node died, disk gone | cold-load from the substrate | **yes** |

The engine seals at 1024 records / 8 MiB, and one cascade over the shipped
fixture appends **29** — so without an explicit `checkpoint()` a small mesh has
written *nothing* to the substrate and a cold load fails outright. The
persistence test asserts both halves deliberately.
:::

### M2 — A2A transport

`off` means **no routes at all**, not a handler that declines:

```bash
NOETL_SIGNAL_MESH_A2A=serve \
NOETL_SIGNAL_MESH_A2A_TOKEN=dev-token \
cargo run --bin signal-mesh-serve

curl -H 'Authorization: Bearer dev-token' \
     localhost:8787/.well-known/agent-card.json
```

| route | |
| :-- | :-- |
| `GET /.well-known/agent-card.json` | the card, projected from a catalog entry |
| `POST /a2a/tasks` | submit a task; negotiates on `Major.Minor` |
| `POST /a2a/tasks/{id}/resume` | resume an **interrupted** task |
| `GET /metrics` | counters, every series pinned at 0 |

A card declaring **no** security scheme is **refused rather than served** — "no
scheme" means *not publishable outside the cluster*, not *open*.

### M9 — operability

```bash
NOETL_SIGNAL_MESH_METRICS_ADDR=127.0.0.1:9797   # unset = no listener at all
```

Independent of the A2A flag on purpose: before M9 the only `/metrics` rode the
A2A router, so a deployment could not be observed without also exposing its
agent surface.

Every series is pinned at **0 for both stores**, including the one that is not
configured — so absent reads exactly like zero rather than like a broken
exporter. `signal_mesh_build_info` is always `1`, which makes *"does this pod
predate that metric?"* answerable from the scrape instead of from an image tag.

## Scope and non-goals

The MVP is a fixed three-tier set, **one** collector shard, the **deterministic**
reasoner, serial execution, and `Strong` reads. Stated honestly, v1 does **not**
include:

- **Bounded-staleness reads** — routing always returns the owner; "reads reach
  region" is a design position, not a capability.
- **A real model.** The reasoner is deterministic. Nothing here evaluates
  whether a model's reasoning is *good*.
- **Executing generated steps.** Generated steps are proposed, never executed;
  there is no execution path at all, and `python` stays structurally denied.
- **A durability guarantee stronger than EHDB's own.** EHDB's unsealed tail is
  RF=1. The mesh inherits that and must not claim otherwise.
- **Auto-scaling collectors, tier parallelism, concurrency and recovery**
  (planned as M5/M6).
- **Multi-tenancy.** One mesh, one tenant, one dataset.
- **A stated workload.** The scale targets in the blueprint are *design*
  targets; the first real device shape should replace them.

## Run it

```bash
cargo run --bin signal-mesh-demo
```

Deterministic — same output every run, with no clock, no network and no model.
It prints the Agent Cards, the collector appends, the tier-by-tier cascade, the
full ReAct trace, the verdict, and a replay check that re-folds the same prefix.
With the shipped fixture the verdict is `52.5000`, `true` against a threshold of
`50.0`.

## Source of truth

The documents in the repo are the source of truth; this page summarizes them.

| document | what it is |
| :-- | :-- |
| [Architecture blueprint](https://github.com/noetl/signal-mesh/blob/main/docs/architecture/a2a-signal-mesh-blueprint.md) | the team reference, diagram-forward — **start here** |
| [Implementation / proof spec](https://github.com/noetl/signal-mesh/blob/main/docs/spec/a2a-react-signal-mesh.md) | grounding with `file:line` evidence, and §11 "what the POC does NOT prove" |
| [Production implementation plan](https://github.com/noetl/signal-mesh/blob/main/docs/production-implementation-plan.md) | M1–M9, the dependency graph, the flag matrix, and the MVP cut |
| [Deployment specification](https://github.com/noetl/signal-mesh/blob/main/docs/deployment-specification.md) | the runtime contract — every env var with its *why*, ports, probes, rollback |
| [noetl/signal-mesh](https://github.com/noetl/signal-mesh) · [wiki](https://github.com/noetl/signal-mesh/wiki) | the crate |

signal-mesh depends on `ehdb-core` as a library, pinned by git tag — a tag and
not a branch, because a branch dependency makes every build a different build.
It was split out of `noetl/ehdb` on 2026-09-21 with history preserved.

## See also

- [Architecture](/docs/getting-started/architecture) — where EHDB sits in the platform
- [Authoring playbooks with AI agents](/docs/tutorials/ai_agent_playbook_authoring)
