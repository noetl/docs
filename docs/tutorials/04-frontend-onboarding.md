---
title: 'Frontend developer onboarding'
sidebar_label: '04 · Frontend Onboarding'
sidebar_position: 4
description: 'Long-form walkthrough for building a frontend that talks to the NoETL gateway: Auth0 flow, session token storage, GraphQL executePlaybook calls, SSE for live updates, error handling, and production hardening. About 45 minutes.'
---

# Frontend developer onboarding

> **Status:** stub. This tutorial is a long-form expansion of the
> existing [Frontend Quickstart](../gateway/frontend-quickstart.md)
> reference, with a runnable starter app and complete worked examples.
> Queued for a subsequent tutorial round.

This tutorial walks you through building a frontend that authenticates
through Auth0, exchanges the resulting `id_token` for a NoETL gateway
session, and calls playbooks via GraphQL with live execution updates
over SSE. By the end you have a small but complete React + TypeScript
app that demonstrates every gateway integration concern a real frontend
needs to handle.

Estimated time: 45 minutes.

## Prerequisites

<!-- TODO -->
- Completed [Quickstart](./01-quickstart.md) so you have a running
  gateway at `http://localhost:<port>` (local) or `https://gateway.your-domain/`
  (after [GKE production deploy](./02-gke-production-deploy.md)).
- Node 18+ and npm/pnpm/yarn.
- An Auth0 tenant with a Single Page Application client configured.
  Callback URLs need to include your dev URL (`http://localhost:5173`
  for Vite default).

## Step 1 — Setup

<!-- TODO:
  - Either link to a starter template repo OR scaffold from create-vite
    with React + TypeScript
  - Add @auth0/auth0-react and @apollo/client (or urql, or vanilla
    fetch — pick one as canonical)
  - Show the directory layout
  - Reference: gateway/api-usage.md has a vanilla fetch baseline
-->

## Step 2 — Auth0 integration

<!-- TODO:
  - Wrap the app in <Auth0Provider> with domain + client_id + redirect_uri
  - Use the loginWithRedirect / logout / getIdTokenClaims hooks
  - Show the Auth0Provider config inline
-->

## Step 3 — Exchange Auth0 token for gateway session

<!-- TODO:
  - POST /api/auth/login with {auth0_token, auth0_domain,
    session_duration_hours}
  - Capture session_token from the response
  - Store it: HttpOnly cookie via a small server-side proxy is the
    canonical pattern. In-memory is acceptable for a SPA. NEVER
    localStorage — explain why.
  - Reference: gateway/api-usage.md "Step 2: Exchange Auth0 Token for
    Session"
-->

## Step 4 — Make a GraphQL `executePlaybook` call

<!-- TODO:
  - Apollo client setup with the session_token in Authorization header
  - The mutation:
    mutation Exec($path: String!, $payload: JSON!) {
      executePlaybook(path: $path, payload: $payload) {
        executionId status
      }
    }
  - Capture executionId from the response
  - Note: alternative with vanilla fetch + custom hook
-->

## Step 5 — Poll for completion via `getExecution`

<!-- TODO:
  - Query: getExecution(id: $id) { status result events { ... } }
  - Polling strategy: start at 500ms, exponential backoff to 4s cap,
    stop at terminal status
  - This pattern mirrors the noetl-side adaptive backoff filed in
    sync/issues/2026-05-07-noetl-adaptive-retry-backoff-tail-latency.md
    — same tradeoffs apply
-->

## Step 6 — SSE for live execution updates

<!-- TODO:
  - GET /api/execution/{id}/stream returns a text/event-stream
  - Use EventSource API (or @microsoft/fetch-event-source for cleaner
    auth header handling)
  - Event format: each event has a name + data payload
  - When to use SSE vs polling: SSE for long-running playbooks where
    you want sub-second updates; polling for quick playbooks where
    one round-trip is enough
  - Cite repos/gateway/src/sse.rs for the server-side implementation
-->

## Step 7 — Error handling

<!-- TODO:
  - 401 Unauthorized → session expired → trigger Auth0 re-login
  - 403 Forbidden → check_access denied → surface "permission denied"
    to user with the playbook path
  - 5xx Server Error → retry with backoff up to N times, then surface
    to user
  - Network errors → distinguish from server errors; usually
    indicates the gateway is unreachable
  - Show the try/catch + status switch as a reusable hook
-->

## Step 8 — Production hardening

<!-- TODO:
  - HttpOnly cookies for session_token (server-side proxy required)
  - CORS config (server-side; cite repos/gateway/src/proxy.rs)
  - Token refresh strategy (gateway-side handles it; just refetch on
    401)
  - Rate limiting / request deduplication client-side
  - Monitoring: capture _meta.diagnosis_fetch.elapsed_seconds from
    the diagnose path of any playbook your frontend invokes —
    operators want to see latency distribution per backend over time
  - CSP headers
-->

## Next steps

<!-- TODO -->
- [Self-troubleshooting playbook](./03-self-troubleshooting-playbook.md)
  — call a playbook that diagnoses its own failures from your frontend.
- [Add a new MCP backend](./05-add-new-mcp-backend.md) — extend the
  platform if your frontend needs a backend the platform doesn't
  have yet.

## Troubleshooting

<!-- TODO: top 5 frontend-side gotchas
  - CORS errors: gateway needs the frontend origin in its allowed list
  - Auth0 redirect_uri mismatch: dev URL not registered
  - session_token not propagating: usually missing Authorization
    header on a hook outside the auth context
  - SSE connection drops on mobile: use fetch-event-source with
    auto-reconnect
  - "executionId" coming back null: usually means the playbook
    failed validation at the gateway layer; check the GraphQL
    response.errors
-->
