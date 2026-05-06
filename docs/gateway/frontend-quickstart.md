---
sidebar_position: 9
title: Frontend Gateway Quickstart
description: Build a browser frontend that authenticates through the NoETL Gateway and executes playbooks with GraphQL, polling, or SSE.
---

# Frontend Gateway Quickstart

The NoETL Gateway is the public edge for browser applications. It exchanges
Auth0 identity tokens for short-lived Gateway sessions, enforces playbook
access checks, exposes GraphQL execution helpers, and proxies selected NoETL
API calls without exposing the in-cluster NoETL server.

For the current GKE deployment:

- Gateway URL: `https://gateway.mestumre.dev`
- GUI URL: `https://mestumre.dev`
- NoETL server: private `ClusterIP` only, reached by the Gateway inside GKE
- Auth backend: Auth0 through the Gateway auth playbooks

## Auth Flow

The browser authenticates with Auth0 first, then sends the returned `id_token`
to the Gateway. The Gateway validates the identity, creates a session, and
returns a `session_token` used for GraphQL, proxy calls, polling, and SSE.

```js
const gatewayUrl = "https://gateway.mestumre.dev";
const auth0Domain = "mestumre-development.us.auth0.com";
const clientId = "<auth0-spa-client-id>";

export function redirectToAuth0() {
  const redirectUri = `${window.location.origin}/login`;
  const nonce = crypto.randomUUID();
  sessionStorage.setItem("auth0_nonce", nonce);

  const params = new URLSearchParams({
    response_type: "id_token token",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email",
    nonce,
  });

  window.location.href = `https://${auth0Domain}/authorize?${params}`;
}

export async function finishLoginFromCallbackHash() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const idToken = hash.get("id_token");
  if (!idToken) throw new Error("Auth0 callback did not include id_token");

  const response = await fetch(`${gatewayUrl}/api/auth/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      auth0_token: idToken,
      auth0_domain: auth0Domain,
      session_duration_hours: 8,
    }),
  });

  if (!response.ok) {
    throw new Error(`Gateway login failed: ${response.status}`);
  }

  const session = await response.json();
  window.history.replaceState(null, "", window.location.pathname);
  return session.session_token;
}
```

See also [Auth Integration](./auth-integration.md) and
[API Usage Guide](./api-usage.md).

## Session Token Storage

Prefer an HttpOnly, Secure, SameSite cookie set by your own frontend backend
when you have one. That keeps the Gateway session out of JavaScript and reduces
the blast radius of an XSS bug.

For static SPAs, keep the token in memory and refresh it through a login flow
when the page reloads. Avoid `localStorage`: it survives longer than the page
session and is readable by any injected JavaScript.

If you must bridge a reload during local development, use `sessionStorage`
only and clear it on logout.

## GraphQL ExecutePlaybook

The canonical browser call is a GraphQL mutation with
`Authorization: Bearer <session_token>`.

```js
export async function executePlaybook(sessionToken, name, variables = {}) {
  const response = await fetch("https://gateway.mestumre.dev/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      query: `
        mutation ExecutePlaybook($name: String!, $vars: JSON) {
          executePlaybook(name: $name, variables: $vars) {
            executionId
            status
          }
        }
      `,
      variables: {name, vars: variables},
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }

  return payload.data.executePlaybook.executionId;
}
```

Apollo and urql use the same endpoint. Add an auth link or exchange that sets
the `Authorization` header before each operation.

```js
// Apollo
const authLink = setContext((_, {headers}) => ({
  headers: {...headers, Authorization: `Bearer ${sessionToken}`},
}));
```

```js
// urql
const client = createClient({
  url: "https://gateway.mestumre.dev/graphql",
  fetchOptions: () => ({
    headers: {Authorization: `Bearer ${sessionToken}`},
  }),
});
```

## Polling Execution Status

For simple pages, poll the NoETL execution API through the authenticated
Gateway proxy.

```js
export async function waitForExecution(sessionToken, executionId) {
  for (;;) {
    const response = await fetch(
      `https://gateway.mestumre.dev/noetl/executions/${executionId}`,
      {headers: {Authorization: `Bearer ${sessionToken}`}},
    );

    if (!response.ok) {
      throw new Error(`Execution status failed: ${response.status}`);
    }

    const doc = await response.json();
    if (["COMPLETED", "FAILED", "ERROR", "CANCELLED"].includes(doc.status)) {
      return doc;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
```

## SSE Live Updates

For live UI updates, open the Gateway SSE stream:

```js
const events = new EventSource(
  `https://gateway.mestumre.dev/events?session_token=${encodeURIComponent(sessionToken)}`,
);

events.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log("NoETL update", update);
};

events.onerror = () => {
  events.close();
};
```

The server implementation lives in `repos/gateway/src/sse.rs`. See
[Async Callbacks](./async-callbacks.md) for the callback and SSE model.

## Error Handling

- `401`: the session token is missing, expired, or invalid. Redirect to login.
- `403`: the user is authenticated but does not have access to the playbook.
- `404`: the playbook path or proxied route is wrong.
- `409`: a duplicate client request or idempotency conflict.
- `429`: slow down and retry with backoff.
- `5xx`: show a retryable error and keep the execution id if one exists.

Always surface the execution id in UI errors when the Gateway returns one.

## Common Patterns

- Keep one Gateway client module that owns login, GraphQL, polling, and SSE.
- Pass playbook variables as plain JSON; keep secrets in NoETL credentials or
  keychain resources, not browser payloads.
- Use a stable `clientId` for async flows so reconnects can associate updates
  with the same browser tab or workflow.
- Prefer named playbook paths over hard-coded catalog ids.

## Gotchas

- CORS must include the frontend origin. The GKE deploy currently includes
  `https://mestumre.dev`, `https://gateway.mestumre.dev`, and local
  development origins.
- Auth0 callback URLs, logout URLs, and web origins must include the deployed
  frontend URL.
- Token refresh races are normal in SPAs. Serialize refresh/login work so two
  tabs do not overwrite each other's session state.
- Do not call the private NoETL service directly from browsers. Use the
  Gateway or a local port-forward for operator debugging.

## Local Development

Run the frontend locally and point it at the deployed Gateway:

```bash
export VITE_GATEWAY_URL=https://gateway.mestumre.dev
npm install
npm run dev
```

The Gateway CORS config allows local development origins for this deployment.
If you use a new port, add it to the Gateway CORS settings before testing.

## GKE Deployment URLs

This round deployed the GKE stack with:

- NoETL image: `ghcr.io/noetl/noetl:v2.35.9`
- Gateway image: `ghcr.io/noetl/gateway:v2.10.0`
- GUI image: `ghcr.io/noetl/gui:v1.7.0`
- Gateway: `https://gateway.mestumre.dev`
- GUI: `https://mestumre.dev`

The Gateway requires authentication for GraphQL and `/noetl/*` proxy routes.
The in-cluster NoETL Service remains `ClusterIP`.

## Worked Example: Diagnose With Vertex Override

The deployment-mode-aware triage design is described in
[Vertex AI Triage Backend](../architecture/vertex_ai_triage_backend.md). A
frontend can dispatch the troubleshoot playbook through the Gateway and select
the Vertex backend explicitly:

```js
const executionId = await executePlaybook(
  sessionToken,
  "automation/agents/troubleshoot/diagnose_execution",
  {
    execution_id: "620639499126571527",
    triage_mcp_server: "mcp/vertex-ai",
    triage_model: "gemini-2.0-flash",
    escalate_to: "none",
  },
);
```

During the 2026-05-06 GKE deploy, the NoETL stack reached Vertex AI through
Workload Identity and captured `source: "vertex-ai"` plus token usage. The
project returned Vertex 404 for `gemini-2.0-flash` and
`gemini-2.0-flash-001`; the compatibility proof used the project-accessible
`gemini-2.5-flash` model. Keep the payload model aligned with the models
enabled for your GCP project.

