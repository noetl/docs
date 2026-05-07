---
title: 'Frontend developer onboarding'
sidebar_label: '04 · Frontend Onboarding'
sidebar_position: 4
description: 'Long-form walkthrough for building a frontend that talks to the NoETL gateway: Auth0 flow, session token storage, GraphQL executePlaybook calls, SSE for live updates, error handling, and production hardening. About 45 minutes.'
---

# Frontend developer onboarding

This tutorial walks you through building a frontend that authenticates
through Auth0, exchanges the resulting `id_token` for a NoETL gateway
session, and calls playbooks via GraphQL with live execution updates
over SSE. By the end you have a small but complete React + TypeScript
app that demonstrates every gateway integration concern a real frontend
needs to handle.

If you only need a short reference to copy patterns from, the
[Frontend Quickstart](../gateway/frontend-quickstart.md) page is
denser. This tutorial is the long-form walk through with an actually
runnable starter.

Estimated time: 45 minutes.

## Prerequisites

- Either a local NoETL gateway from [Quickstart](./01-quickstart.md)
  (`http://localhost:8090`) or a deployed gateway from
  [GKE Production Deploy](./02-gke-production-deploy.md)
  (`https://gateway.<your-domain>`).
- Node 18+ and npm/pnpm/yarn.
- An Auth0 tenant with a Single Page Application client configured.
  Callback URLs need to include `http://localhost:5173` (Vite dev
  default) for local development. See
  [Auth0 Setup](../gateway/auth0-setup.md) if you haven't configured
  the tenant yet.

## Step 1 — Setup

Scaffold a Vite + React + TypeScript starter:

```bash
npm create vite@latest noetl-frontend -- --template react-ts
cd noetl-frontend
npm install

# Add the libraries we'll use
npm install @auth0/auth0-react graphql-request
```

This tutorial uses **vanilla `fetch` + `graphql-request`** as the
canonical example — the smallest dependency footprint that still
gets you typed GraphQL responses. Apollo Client and urql are popular
alternatives; the contract with the gateway is identical, only the
client-side ergonomics differ.

Project structure (the bits we'll touch):

```text
src/
  App.tsx           — root component, wraps in <Auth0Provider>
  auth.ts           — session_token exchange + storage
  api.ts            — gateway GraphQL client wrapper
  hooks/
    useExecution.ts — polling and SSE subscription helpers
  components/
    LoginButton.tsx
    PlaybookRunner.tsx
```

## Step 2 — Auth0 integration

Wrap the app in `<Auth0Provider>`:

```tsx
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './App';

const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN!;
const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID!;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        scope: 'openid profile email',
      }}
      cacheLocation="memory"
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>
);
```

`cacheLocation="memory"` is a deliberate choice — it keeps Auth0's
internal cache out of `localStorage`, which sidesteps a class of XSS
attacks. We'll apply the same principle to the gateway session token
in step 3.

A minimal login button:

```tsx
// src/components/LoginButton.tsx
import { useAuth0 } from '@auth0/auth0-react';

export function LoginButton() {
  const { isAuthenticated, loginWithRedirect, logout, user } = useAuth0();

  if (isAuthenticated) {
    return (
      <div>
        <span>Hi, {user?.name}</span>
        <button onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
          Log out
        </button>
      </div>
    );
  }
  return <button onClick={() => loginWithRedirect()}>Log in</button>;
}
```

## Step 3 — Exchange Auth0 token for gateway session

After `loginWithRedirect` returns, you have an Auth0 `id_token` but the
gateway needs its own session token. Exchange it via `POST
/api/auth/login`:

```ts
// src/auth.ts
const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL!;
const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN!;

let cachedSessionToken: string | null = null;

export async function exchangeForSession(auth0Token: string): Promise<string> {
  const resp = await fetch(`${GATEWAY_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth0_token: auth0Token,
      auth0_domain: AUTH0_DOMAIN,
      session_duration_hours: 8,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Session exchange failed: ${resp.status}`);
  }
  const data = await resp.json();
  cachedSessionToken = data.session_token;
  return data.session_token;
}

export function getSessionToken(): string | null {
  return cachedSessionToken;
}

export function clearSession() {
  cachedSessionToken = null;
}
```

**Storing the session token securely.** Three options, in order of
preference:

1. **HttpOnly cookie via a server-side proxy** (best). Your
   frontend talks to a tiny Node/Edge proxy that holds the cookie;
   the proxy forwards GraphQL calls to the gateway with the cookie
   attached. JavaScript in the browser never sees the token. Best
   defense against XSS theft.
2. **In-memory variable** (acceptable for SPAs). The pattern above —
   `cachedSessionToken` lives in a module-level variable, dies on
   page refresh, gets re-acquired through Auth0's silent
   reauthentication. Vulnerable to XSS for the duration of the page
   session, but XSS in your app is the bigger problem at that point.
3. **`localStorage`** (DON'T). Persists across tabs and reloads,
   which sounds nice, but means any XSS payload that runs in your
   app permanently exfiltrates the token to attacker-controlled
   domains. Even one third-party script with a vulnerability is
   enough.

The in-memory pattern above means users re-auth on every page reload.
For SPAs that's usually fine; if you need cross-tab persistence,
build the server-side proxy.

Wire the exchange into the auth flow:

```tsx
// src/App.tsx
import { useAuth0 } from '@auth0/auth0-react';
import { useEffect, useState } from 'react';
import { exchangeForSession } from './auth';
import { LoginButton } from './components/LoginButton';
import { PlaybookRunner } from './components/PlaybookRunner';

export default function App() {
  const { isAuthenticated, getIdTokenClaims } = useAuth0();
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      const claims = await getIdTokenClaims();
      if (!claims?.__raw) return;
      await exchangeForSession(claims.__raw);
      setSessionReady(true);
    })();
  }, [isAuthenticated, getIdTokenClaims]);

  return (
    <main>
      <h1>NoETL Frontend</h1>
      <LoginButton />
      {sessionReady && <PlaybookRunner />}
    </main>
  );
}
```

## Step 4 — Make a GraphQL `executePlaybook` call

Build a thin GraphQL client wrapper that injects the session token:

```ts
// src/api.ts
import { GraphQLClient, gql } from 'graphql-request';
import { getSessionToken } from './auth';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL!;

function gatewayClient() {
  const token = getSessionToken();
  if (!token) throw new Error('No active session — log in first.');
  return new GraphQLClient(`${GATEWAY_URL}/graphql`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const EXECUTE_PLAYBOOK = gql`
  mutation ExecutePlaybook($path: String!, $payload: JSON!) {
    executePlaybook(path: $path, payload: $payload) {
      executionId
      status
    }
  }
`;

export interface ExecuteResult {
  executionId: string;
  status: string;
}

export async function executePlaybook(
  path: string,
  payload: Record<string, unknown>,
): Promise<ExecuteResult> {
  const client = gatewayClient();
  const result = await client.request<{ executePlaybook: ExecuteResult }>(
    EXECUTE_PLAYBOOK,
    { path, payload },
  );
  return result.executePlaybook;
}
```

A simple component that runs the spike playbook:

```tsx
// src/components/PlaybookRunner.tsx
import { useState } from 'react';
import { executePlaybook } from '../api';

export function PlaybookRunner() {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSpike() {
    setError(null);
    try {
      const result = await executePlaybook('tests/spike/spike_e2e_test', {
        escalate_to: 'none',
        triage_mcp_server: 'mcp/vertex-ai',
        triage_model: 'gemini-2.5-flash',
      });
      setExecutionId(result.executionId);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section>
      <button onClick={runSpike}>Run spike playbook</button>
      {executionId && <p>Started: {executionId}</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </section>
  );
}
```

## Step 5 — Poll for completion via `getExecution`

Once you have an `executionId`, poll for terminal status with
exponential backoff. The pattern mirrors the noetl-side adaptive retry
in `_fetch_persisted_diagnosis_from_doc` — start short, grow, cap.

```ts
// src/hooks/useExecution.ts
import { useEffect, useState } from 'react';
import { GraphQLClient, gql } from 'graphql-request';
import { getSessionToken } from '../auth';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL!;

const GET_EXECUTION = gql`
  query GetExecution($id: String!) {
    getExecution(id: $id) {
      status
      result
    }
  }
`;

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function useExecution(executionId: string | null) {
  const [state, setState] = useState<{
    status: string | null;
    result: unknown;
    error: string | null;
  }>({ status: null, result: null, error: null });

  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    let sleep = 500; // 0.5s initial
    const deadline = Date.now() + 60_000;

    const poll = async () => {
      while (!cancelled && Date.now() < deadline) {
        try {
          const token = getSessionToken();
          const client = new GraphQLClient(`${GATEWAY_URL}/graphql`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await client.request<{
            getExecution: { status: string; result: unknown };
          }>(GET_EXECUTION, { id: executionId });
          const { status, result } = data.getExecution;
          if (cancelled) return;
          setState({ status, result, error: null });
          if (TERMINAL.has(status)) return;
        } catch (e) {
          setState((s) => ({ ...s, error: String(e) }));
        }
        await new Promise((r) => setTimeout(r, sleep));
        sleep = Math.min(sleep * 1.5, 4000);
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [executionId]);

  return state;
}
```

The adaptive cadence (0.5s → 4s cap, 60s deadline) matches what
v2.37.0 ships for the noetl-side diagnose-fetch loop. Same tradeoffs:
warm path completes fast, cold path stretches without making warm
gratuitously slow.

## Step 6 — SSE for live execution updates

Polling is fine for short playbooks. For long-running ones (multi-step
ETL, anything orchestrating multiple sub-playbooks), Server-Sent
Events deliver per-event updates without the polling overhead. The
gateway exposes `GET /api/execution/{id}/stream` returning a
`text/event-stream`. See [`repos/gateway/src/sse.rs`](https://github.com/noetl/gateway/blob/main/src/sse.rs)
for the server-side implementation.

The browser `EventSource` API doesn't support custom headers, so for
authenticated streams use
[`@microsoft/fetch-event-source`](https://www.npmjs.com/package/@microsoft/fetch-event-source):

```ts
// src/hooks/useExecutionStream.ts
import { useEffect, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getSessionToken } from '../auth';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL!;

export function useExecutionStream(executionId: string | null) {
  const [events, setEvents] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!executionId) return;
    const ctrl = new AbortController();
    const token = getSessionToken();

    fetchEventSource(`${GATEWAY_URL}/api/execution/${executionId}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      onmessage: (msg) => {
        try {
          const data = JSON.parse(msg.data);
          setEvents((prev) => [...prev, data]);
        } catch {
          /* skip malformed */
        }
      },
      onerror: (err) => {
        setError(String(err));
        // throw to stop default reconnect; remove to enable auto-reconnect
        throw err;
      },
    }).catch(() => {});

    return () => ctrl.abort();
  }, [executionId]);

  return { events, error };
}
```

When to use SSE vs polling: SSE for real-time progress feedback
(progress bars, log streams, multi-step playbooks where each step's
events are user-visible). Polling for fire-and-forget playbooks where
the user just needs to know "done or not." Both are first-class.

## Step 7 — Error handling

Map gateway responses to user-meaningful states:

```ts
// src/api.ts (extend)
export class GatewayError extends Error {
  constructor(public status: number, public detail: string) {
    super(`${status}: ${detail}`);
  }
}

export async function safeExecute(
  path: string,
  payload: Record<string, unknown>,
): Promise<ExecuteResult> {
  try {
    return await executePlaybook(path, payload);
  } catch (e: any) {
    const status = e.response?.status ?? 0;
    const detail = e.response?.errors?.[0]?.message ?? String(e);

    if (status === 401) {
      // Session expired. Trigger Auth0 silent re-login.
      throw new GatewayError(401, 'Session expired — please log in again.');
    }
    if (status === 403) {
      throw new GatewayError(403, `Permission denied for playbook ${path}.`);
    }
    if (status >= 500) {
      throw new GatewayError(status, 'Gateway error. Please retry.');
    }
    throw new GatewayError(status, detail);
  }
}
```

In the component, catch `GatewayError` and surface user-meaningful
copy:

- **401**: trigger `loginWithRedirect()` via Auth0, then retry.
- **403**: show the playbook path and a "contact your admin" message
  with a copy-paste of the path so the user can ask for access.
- **5xx**: retry up to 3 times with backoff, then show a generic
  "service unavailable" message with a link to your status page.
- **Network errors** (status === 0): show "gateway unreachable" — usually
  means the user's network is offline, not a server issue.

## Step 8 — Production hardening

Items to address before shipping:

- **HttpOnly cookies** for session tokens. Build a small server-side
  proxy (Cloudflare Worker, Vercel Edge Function, or a 50-line
  Node/Express service) that holds the session cookie and forwards
  GraphQL calls to the gateway. The frontend calls the proxy origin;
  the proxy attaches the cookie. Eliminates the in-memory token's
  XSS exposure window.
- **CORS configuration**. The gateway needs your frontend's origin in
  its allowed list. See [`repos/gateway/src/proxy.rs`](https://github.com/noetl/gateway/blob/main/src/proxy.rs)
  for where this is configured server-side. Common gotcha: the
  configured origin must match exactly including protocol and port.
- **Token refresh**. Gateway sessions are valid for the
  `session_duration_hours` requested at exchange time (default 8). On
  401 from any GraphQL call, trigger Auth0 silent re-auth and a fresh
  exchange. The Auth0 SDK's `getAccessTokenSilently` handles the
  Auth0 side automatically.
- **CSP headers**. Set `Content-Security-Policy: script-src 'self'`
  on your origin. Tightening to `'self'` only is the single biggest
  XSS mitigation you can ship.
- **Cost monitoring**. Capture
  `_meta.diagnosis_fetch.elapsed_seconds` and `_meta.usage.*` from
  any playbook your frontend invokes that goes through the
  auto-troubleshoot path. Operators want this for cost-per-execution
  visibility — see
  [Vertex AI Triage Backend → Cost telemetry](../architecture/vertex_ai_triage_backend.md)
  for what to monitor.
- **Rate limiting**. Debounce repeated `executePlaybook` calls
  client-side; the gateway will accept many concurrent requests
  but each one queues a real execution which costs real
  Vertex/cluster resources.

## Next steps

- [Self-troubleshooting playbook](./03-self-troubleshooting-playbook.md)
  — call a playbook that diagnoses its own failures from your
  frontend; render the structured diagnosis dict in the UI.
- [Add a new MCP backend](./05-add-new-mcp-backend.md) — extend the
  platform if your frontend needs a triage backend the platform
  doesn't ship yet.

## Troubleshooting

**CORS errors** ("`No 'Access-Control-Allow-Origin' header`"). The
gateway hasn't been told about your frontend's origin. Add it to the
gateway's CORS allowlist (configured in
[`repos/gateway/src/proxy.rs`](https://github.com/noetl/gateway/blob/main/src/proxy.rs)
on the server side; in production, often via an environment variable
the gateway reads at startup). Restart the gateway pod after the
config change.

**Auth0 redirect_uri mismatch.** Login redirects to Auth0, you
authenticate, then Auth0 returns "callback URL not allowed." Re-check
the Auth0 SPA client's Allowed Callback URLs include your dev URL
(`http://localhost:5173`) AND any production frontend URL. Auth0's
match is exact-string including trailing slash; copy carefully.

**`session_token` not propagating to GraphQL calls.** Usually a hook
that uses `getSessionToken()` outside the auth context — gets called
before `exchangeForSession` completes and gets `null`. Confirm the
component that calls `executePlaybook` only renders after
`sessionReady` is true (see step 3's `App.tsx`).

**SSE connection drops silently after 30 seconds.** Usually a load
balancer / proxy in front of the gateway with a default idle timeout
shorter than the SSE keepalive cadence. Either tune the LB timeout up
to 5+ minutes, or switch to long-polling. The gateway's
[`sse.rs`](https://github.com/noetl/gateway/blob/main/src/sse.rs) emits
keepalive comments every 15 seconds; if those aren't reaching the
client, something between you and the gateway is buffering or
terminating the connection.

**`executionId` comes back null.** The `executePlaybook` mutation
succeeded structurally but the playbook failed validation at the
gateway. Check `response.errors` from the GraphQL client — typically
"playbook not found in catalog" or "payload schema mismatch." Confirm
the playbook is registered in the GKE catalog (per
[GKE production deploy step 5](./02-gke-production-deploy.md)) and
that your payload matches the playbook's `workload` schema.
