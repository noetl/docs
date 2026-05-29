---
title: 'Tutorial 8.7 — Business data via playbooks (Firestore worked example)'
sidebar_label: '8.7. Business data via playbooks'
sidebar_position: 8.7
description: 'Step-by-step implementation guide for the no-direct-database pattern: SPA reads and writes business data exclusively through playbook executions. Built on the Adiona/muno trip planner using Firestore as the worked example; adapts to Postgres, Dynamo, your-backend-of-choice.'
---

# Tutorial 8.7 — Business data via playbooks

By the end of this tutorial you can:

- explain why neither the SPA nor the gateway ever touches a
  business-data store directly, and what does touch it instead;
- walk a single user chat turn from the SPA's outgoing GraphQL
  request to the Firestore document write to the SPA's calendar
  refresh, naming the playbook step that owns each hop;
- swap Firestore for a different backend by editing one agent
  playbook plus your domain orchestrator's dispatch lines —
  without touching the SPA, the widget contract, or the gateway.

This tutorial uses the Adiona/muno trip-planner as the running
example. If you haven't seen the higher-level capstone yet, read
[Tutorial 8 — Trip planner end-to-end](./08-trip-planner-end-to-end.md)
first; this tutorial zooms in on the **business-data-in-Firestore-
by-playbooks** pattern, which Tutorial 8 introduces but doesn't
walk in implementation detail.

## What this pattern is, in one paragraph

A NoETL playbook is the only thing in the system that touches
business data. The browser SPA cannot import a database client.
The gateway proxies authenticated requests through `/noetl/*` and
serves SSE; its Rust binary has zero database crates compiled in.
The worker that picks up a playbook execution is the only entity
that reads and writes business data, and it does so by running
playbook steps that dispatch to **agent playbooks** wrapping the
storage backend.

For travel-on-Firestore that wrapper is
[`automation/agents/mcp/firestore.yaml`](https://github.com/noetl/ops/blob/main/automation/agents/mcp/firestore.yaml)
in `noetl/ops`. We'll reference it constantly below.

## The cast

| Piece | Role | Source |
|---|---|---|
| `firestore_mcp` agent playbook | Wraps Firestore. Exposes 8 tool kinds: `set_doc`, `batch_set_docs`, `get_doc`, `batch_get_docs`, `query_collection`, `delete_doc`, `append_event`, `batch_append_events`, `replay_events`. | [`automation/agents/mcp/firestore.yaml`](https://github.com/noetl/ops/blob/main/automation/agents/mcp/firestore.yaml) |
| `muno/playbooks/itinerary-planner` | The orchestrator that runs one execution per chat turn. Loads slot state, runs the LLM extractor, persists turn docs + events, renders widgets. | [`playbooks/itinerary-planner.yaml`](https://github.com/noetl/travel/blob/main/playbooks/itinerary-planner.yaml) |
| `travel/playbooks/catalog/calendar/list` | The read playbook the SPA calls. Dispatches `firestore_mcp.query_collection`, returns a `calendar_view` widget envelope. | [`playbooks/catalog/calendar/list.yaml`](https://github.com/noetl/travel/blob/main/playbooks/catalog/calendar/list.yaml) |
| `calendar.event.touched` event | NoETL event the orchestrator emits after each calendar write. Forwarded by the gateway as an SSE frame so the SPA can re-read. | Emitted from itinerary-planner.yaml; allowlisted in [`gateway/src/playbook_state.rs`](https://github.com/noetl/gateway/blob/main/src/playbook_state.rs) |
| `calendarSubscription.ts` | SPA module. Calls the read playbook on mount; re-runs on each `calendar.event.touched` SSE frame; falls back to `playbook.completed`. | [`src/api/calendarSubscription.ts`](https://github.com/noetl/travel/blob/main/src/api/calendarSubscription.ts) |

For the pattern view (architecture, allowed-edges, swap-the-backend
recipe), see the
[Business data via playbooks](https://github.com/noetl/travel/wiki/business-data-via-playbooks)
page in the travel wiki. This tutorial is the implementation walkthrough.

## Prerequisites

- Tutorial 8 completed (you can drive a chat turn against the
  deployed muno SPA at `travel.mestumre.dev` and see widgets
  render).
- `noetl` CLI installed locally and pointed at gke-prod with a
  fresh login (`noetl auth login --browser-pkce --context
  gke-prod`).
- `gcloud` + `kubectl` configured for project `noetl-demo-19700101`
  and cluster `noetl-cluster`.
- The deployed images include the post-Round-03 cleanup:
  `noetl-gateway:firestore-cleanup-20260529015331` or newer
  on namespace `gateway`, and `noetl:code-scrub-fix-20260528204039`
  or newer on namespace `noetl`. Verify with
  ```bash
  kubectl --context gke_noetl-demo-19700101_us-central1_noetl-cluster \
    -n gateway get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
  ```

## Step 1 — Drive a chat turn and watch the orchestrator

Pick a fresh thread path so you don't collide with another developer:

```bash
THREAD="my-tutorial-$(date -u +%Y%m%dT%H%M%S)"
EXEC=$(noetl --context gke-prod exec catalog://muno/playbooks/itinerary-planner \
  --runtime distributed \
  --payload "{\"user_uid\":null,\"thread_path\":\"chat_threads/$THREAD\",\"user_input\":{\"text\":\"trip to paris\",\"timestamp\":\"$(date -u +%FT%TZ)\"}}" \
  --json | python3 -c 'import sys, json; [print(json.loads(l)["execution_id"]) for l in sys.stdin if l.strip().startswith("{")]')
echo "execution: $EXEC"
```

Wait a few seconds, then list which orchestrator steps ran:

```bash
TOKEN=$(awk '/^  gke-prod:/{flag=1; next} /^  [a-z][a-z0-9_-]*:$/{flag=0} flag && /gateway_session_token:/{print $2; exit}' ~/.noetl/config.yaml)
curl -sS "https://gateway.mestumre.dev/noetl/executions/$EXEC/events" \
  -H "Authorization: Bearer $TOKEN" | \
python3 -c '
import sys, json
d = json.load(sys.stdin)
print(f"status: {d[\"status\"]}, total: {d[\"pagination\"][\"total_events\"]}")
for e in d["events"]:
    if e["event_type"] != "command.completed": continue
    print(f"  {e.get(\"node_name\")}: status={e[\"result\"][\"context\"].get(\"status\")}")'
```

You should see something like:

```
status: COMPLETED, total: 108
  normalize_input: status=...
  load_slot_state: status=ok
  extract_turn: status=...
  persist_turn_docs_atomically: status=ok
  append_turn_events_atomically: status=ok
  render_widget_chat: status=...
  persist_render_docs_atomically: status=ok
  append_render_events_atomically: status=ok
  final_result: status=...
```

The four steps with `status=ok` are the firestore_mcp dispatches.
Each one is a single YAML node in `itinerary-planner.yaml` that
calls the `firestore_mcp` agent with a `tool` + `arguments` payload.

## Step 2 — Read the orchestrator dispatch

Open
[`playbooks/itinerary-planner.yaml`](https://github.com/noetl/travel/blob/main/playbooks/itinerary-planner.yaml)
and search for one of the four steps you just saw. The pattern is
the same for every firestore_mcp call:

```yaml
- step: persist_turn_docs_atomically
  tool:
    kind: agent
    framework: noetl
    entrypoint: automation/agents/mcp/firestore
    payload:
      method: tools/call
      tool: batch_set_docs
      firestore_database: "{{ workload.firestore_database }}"
      arguments:
        items: "{{ extract_turn.context.turn_docs }}"
  next:
    spec: { mode: exclusive }
    arcs:
      - step: append_turn_events_atomically
```

Three things to notice:

1. **`kind: agent` + `framework: noetl` + `entrypoint:`** — this
   is the dispatch to another NoETL playbook, in-process on the
   worker. No gateway hop.
2. **`payload.tool: batch_set_docs`** — picks which firestore_mcp
   tool kind to invoke. Other steps use `get_doc`,
   `batch_append_events`, etc.
3. **`payload.arguments`** — the tool-specific input. For
   `batch_set_docs` it's a list of `{path, doc, merge}` records.
   The list itself is built earlier in this execution by the
   Python step `extract_turn`, which knows what changed this
   turn.

The atomic-batch shape is important: every Firestore write per
turn happens in **one** dispatch, so a turn either lands all its
documents or none. Partial-turn Firestore state is impossible by
construction.

## Step 3 — Read the firestore_mcp agent

Open
[`automation/agents/mcp/firestore.yaml`](https://github.com/noetl/ops/blob/main/automation/agents/mcp/firestore.yaml).
The agent is a single playbook with one `firestore_dispatch`
step that branches on `tool:`. For `batch_set_docs` the
relevant snippet:

```python
def _batch_set_docs(args):
    items = _as_list(args.get("items"))
    if not items:
        return _ok("batch_set_docs", {"count": 0, "items": []}, "0 docs")
    ... 
    # construct a Firestore batch commit request
    body = {"writes": writes}
    ok, status_code, body = _request("POST", commit_path, payload=body)
    if not ok or status_code >= 300:
        return _error("batch_set_docs", "Firestore batch_set_docs failed", body, status_code)
    return _ok("batch_set_docs", {"count": len(items), "items": items},
               f"batch_set_docs {len(items)} docs ok", {"docs_written": len(items)})
```

Two things to notice:

1. The agent calls Firestore via the REST API (HTTPS) with a
   bearer token resolved from the worker's GCP credentials —
   workload identity in GKE, or a service-account JSON locally.
   The auth flow is part of the agent's own keychain block; see
   the noetl wiki's
   [Credential Resolution Flow](https://github.com/noetl/noetl/wiki/credential-resolution-flow)
   for how that resolves end-to-end.
2. The agent emits **structured** results (`_ok` / `_error`
   helpers) that the orchestrator can read via
   `{{ step_name.context.docs_written }}` style references. No
   side-channel signaling.

Substituting a different backend means writing a similarly-shaped
`postgres_mcp.yaml` (or `dynamo_mcp.yaml`) with the same tool
surface. The orchestrator doesn't care — only the `entrypoint:`
field changes.

## Step 4 — Find the calendar event docs in Firestore

If you have `gcloud` configured with the project's Application
Default Credentials, the docs that just got written are visible:

```bash
gcloud firestore documents list \
  "chat_threads/$THREAD" --collection-group events 2>&1 | head -20
```

If you don't have GCP access, query the NoETL event log instead.
The orchestrator emits a `calendar.event.touched` event into the
NoETL log for every Firestore calendar write (we'll watch one in
Step 5):

```bash
TOKEN=$(awk '/^  gke-prod:/{flag=1; next} /^  [a-z][a-z0-9_-]*:$/{flag=0} flag && /gateway_session_token:/{print $2; exit}' ~/.noetl/config.yaml)
curl -sS "https://gateway.mestumre.dev/noetl/postgres/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"SELECT execution_id, created_at, result->'context'->>'summary' AS summary FROM noetl.event WHERE event_type='calendar.event.touched' AND result->'context'->'payload'->>'thread_path'='chat_threads/$THREAD' ORDER BY created_at DESC LIMIT 5\", \"database\":\"noetl\"}" \
  | python3 -m json.tool | head -30
```

Note: a fresh "trip to paris" turn won't emit a
`calendar.event.touched` yet — the orchestrator asks the user to
confirm the destination first. To trigger one, drive a few more
turns until the SPA shows a calendar widget (typically after
confirming a flight or hotel offer). Tutorial 8 covers the chat
flow that gets you there.

## Step 5 — Watch the SSE signal flow

The `calendar.event.touched` event isn't useful unless the SPA
receives it. The chain:

1. Orchestrator (worker-side) emits the event to the NoETL event
   log via `firestore_mcp.batch_append_events`.
2. noetl-server publishes the event on NATS subject
   `noetl.events.<exec_id>.…`.
3. The gateway's `playbook_state.rs` subscribes to that subject.
   For each event it checks `event_type` against
   `FORWARDED_EVENT_TYPES`. As of v2.12.0 the allowlist is:

   ```rust
   const FORWARDED_EVENT_TYPES: &[&str] = &[
       "step.exit",
       "playbook.completed",
       "playbook.failed",
       "calendar.event.touched",
   ];
   ```

4. If the event_type matches, the gateway routes the frame to
   the SPA's SSE channel via `ConnectionHub::send_to_client`.
5. The SPA's `calendarSubscription.ts` listener filters
   `playbook/state` SSE frames by `event_type ===
   "calendar.event.touched"` and re-runs the read playbook.

You can watch step 5 in your browser's DevTools network tab:
open `travel.mestumre.dev`, sign in, open the EventSource
connection to `/events?session_token=...`, and tail it while
driving a calendar-changing turn. You should see SSE frames
of the form:

```
event: playbook/state
data: {"jsonrpc":"2.0", "method":"playbook/state", "params":{
  "execution_id": "...", "event_type": "calendar.event.touched",
  "step_name": "append_render_events_atomically",
  "at": "..."
}}
```

## Step 6 — Read the read playbook

When `calendarSubscription.ts` decides to refresh, it calls
`executePlaybook(catalog://travel/playbooks/catalog/calendar/list, ...)`.
Open
[`playbooks/catalog/calendar/list.yaml`](https://github.com/noetl/travel/blob/main/playbooks/catalog/calendar/list.yaml)
— three steps:

1. `resolve_collection_path` (Python) — derives the Firestore
   collection path from `(user_uid, trip_id, thread_path)`.
   Mirrors the same path logic the orchestrator uses for
   writes, so reads land on exactly the documents writes produce.
2. `query_calendar_events` — the firestore_mcp dispatch:

   ```yaml
   tool:
     kind: agent
     framework: noetl
     entrypoint: automation/agents/mcp/firestore
     payload:
       method: tools/call
       tool: query_collection
       firestore_database: "{{ workload.firestore_database }}"
       arguments:
         collection_path: "{{ resolve_collection_path.collection_path }}"
         order_by:
           field: start_at
           direction: ASCENDING
         limit: 500
   ```

3. `render_calendar_widget` (Python) — assembles a
   `calendar_view` widget envelope from the returned documents,
   conforming to the
   [widget contract schema](https://github.com/noetl/travel/blob/main/playbooks/widget-contract/calendar_view.schema.json).

The SPA receives the widget envelope as a `playbook/result`
SSE frame; it doesn't know where the data lives.

## Step 7 — Adapt for your own backend

Repeat after me: the SPA, the widget contract, the gateway, and
the orchestrator's overall shape are all
**backend-independent**. Switching to another storage backend
touches:

1. **Write a `your_backend_mcp.yaml`** at
   `automation/agents/mcp/<your-backend>.yaml` exposing the same
   tool kinds your orchestrator needs. For most apps that's
   `get_doc`, `batch_set_docs`, `query_collection`, and an
   append-only event helper if you want event sourcing. For
   Postgres that's a SELECT + an INSERT + an upsert via ON
   CONFLICT.
2. **Register the agent playbook** on your NoETL catalog
   (`noetl register playbook -f ...`) and the credentials it
   needs (`noetl register credential -f ...`).
3. **Edit your orchestrator's `entrypoint:` lines**. In
   itinerary-planner.yaml change every
   `entrypoint: automation/agents/mcp/firestore` to
   `entrypoint: automation/agents/mcp/<your-backend>`, and
   rename the `tool:` field to whatever your agent exposes.
4. **Decide on a signal event_type**. Add it to the gateway's
   `FORWARDED_EVENT_TYPES` allowlist
   ([`playbook_state.rs`](https://github.com/noetl/gateway/blob/main/src/playbook_state.rs))
   and rebuild + redeploy the gateway image. One-line PR.
5. **Add a read playbook** at
   `catalog://your-domain/playbooks/catalog/<entity>/list`.
6. **Point the SPA's subscription module** at the new playbook
   + the new signal name. This is the only SPA-side change.

The widget contract — schemas under
`playbooks/widget-contract/*.schema.json` and React renderers
under `src/components/widgets/` — does not change.

## Verifying the pattern holds

Three checks make the rule auditable in CI or a pre-merge sweep:

```bash
# 1. SPA has no DB client imports
grep -r "from 'firebase\|from \"firebase\|from 'pg\|from \"pg\|from 'mongoose\|from \"mongoose" \
  repos/travel/src/ && echo "FAIL" || echo "PASS — no DB client imports"

# 2. Gateway has no DB crate dependencies
grep -E "firestore|postgres|mongo|dynamodb" repos/gateway/Cargo.toml \
  && echo "FAIL" || echo "PASS — no DB crates in gateway"

# 3. Every business-data write traces to a firestore_mcp dispatch in the orchestrator
grep -c "entrypoint: automation/agents/mcp/firestore" repos/travel/playbooks/itinerary-planner.yaml
```

The third check should match the number of distinct write paths
the orchestrator owns (six for the current itinerary-planner:
get_doc + 2× batch_set_docs + 2× batch_append_events, plus one
in the calendar.list read playbook).

## Where this goes next

- [Tutorial 8 — Trip planner end-to-end](./08-trip-planner-end-to-end.md)
  — the architectural context this pattern fits into.
- Travel wiki:
  [Business data via playbooks](https://github.com/noetl/travel/wiki/business-data-via-playbooks)
  — the pattern view + adapt-for-your-domain recipe in reference
  form.
- Travel wiki:
  [Playbook: itinerary-planner](https://github.com/noetl/travel/wiki/playbook-itinerary-planner)
  — step-by-step orchestrator contract.
- Travel wiki:
  [Playbook: calendar/list](https://github.com/noetl/travel/wiki/playbook-calendar-list)
  — read-playbook contract.
- noetl wiki:
  [Credential Resolution Flow](https://github.com/noetl/noetl/wiki/credential-resolution-flow)
  — how the firestore_mcp agent gets its Google service-account
  token at dispatch time without any credentials being stored
  in the orchestrator playbook itself.
- ops wiki:
  [Agent: Firestore MCP](https://github.com/noetl/ops/wiki/agents-mcp-firestore)
  — full tool reference for firestore_mcp, including
  `replay_events` and the partial-replay shape.

## Architecture rule audit

This tutorial is the implementation walkthrough for one
application of the broader architecture rule. The rule itself is
in:

- [Ephemeral Blueprints + Compute-Data Boundary](https://github.com/noetl/docs/blob/main/docs/architecture/ephemeral_blueprints.md)
  in `noetl/docs`.
- [`agents/rules/execution-model.md`](https://github.com/noetl/ai-meta/blob/main/agents/rules/execution-model.md)
  in `noetl/ai-meta` — the agent-facing version that every
  agent reviewing a PR runs proposals against.

If you find your codebase reaching for a `firebase-admin` or
`pg` import in the SPA or the gateway, push back against it
with a link to this pattern.
