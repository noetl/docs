---
id: gcp-current-setup-system-playbooks
title: Current GCP Setup and System Playbook Architecture
sidebar_label: GCP Setup + System Playbooks
sidebar_position: 1
description: Current GKE deployment profile and Auth0 system-playbook architecture used by NoETL.
---

## Scope and intent

This document captures the **current GCP deployment profile** in this repository and the **system playbooks** used for authentication and authorization.

It is based on:

- `automation/gcp_gke/noetl_gke_fresh_stack.yaml`
- `automation/gcp_gke/README.md`
- `repos/e2e/fixtures/playbooks/api_integration/auth0/*.yaml`

Current baseline date: **2026-04-30**.

## Current GCP deployment profile

The active baseline is a GKE Autopilot deployment with Cloud SQL + PgBouncer, where only Gateway and GUI are public.

### Baseline topology

```mermaid
flowchart LR
  User["Browser / API Client"] --> DNS["Cloudflare DNS"]
  DNS --> GW["Gateway Service (LoadBalancer)"]
  DNS --> GUI["GUI Service (LoadBalancer)"]

  subgraph GKE["GKE Autopilot Cluster"]
    GW --> NOETL["NoETL Server API"]
    NOETL --> NATS["NATS JetStream (sessions KV)"]
    NOETL --> PGB["PgBouncer Service"]
    GUI --> GW
  end

  PGB --> SQL["Cloud SQL PostgreSQL (private IP)"]
```

### How this profile is applied

Use `automation/gcp_gke/noetl_gke_fresh_stack.yaml` with:

- `use_cloud_sql=true`
- `cloud_sql_enable_private_ip=true`
- `cloud_sql_enable_public_ip=false`
- `pgbouncer_enabled=true`
- `deploy_postgres=false`
- `deploy_ingress=false`
- `gateway_service_type=LoadBalancer`
- `gui_service_type=LoadBalancer`

Example (existing-cluster deploy):

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml \
  --set action=deploy \
  --set project_id=<gcp-project-id> \
  --set cluster_name=noetl-cluster \
  --set build_images=false \
  --set use_cloud_sql=true \
  --set cloud_sql_enable_private_ip=true \
  --set cloud_sql_enable_public_ip=false \
  --set pgbouncer_enabled=true \
  --set deploy_postgres=false \
  --set deploy_clickhouse=false \
  --set deploy_ingress=false \
  --set gateway_service_type=LoadBalancer \
  --set gui_service_type=LoadBalancer
```

## Auth bootstrap on GCP deploy

When `bootstrap_gateway_auth=true` (default), deploy automation performs:

1. Port-forward to NoETL API (`svc/noetl`)
2. Register credentials:
   - `pg_auth`
   - `nats_credential`
3. Register playbooks:
   - `api_integration/auth0/auth0_login`
   - `api_integration/auth0/auth0_validate_session`
   - `api_integration/auth0/check_playbook_access`
   - `api_integration/auth0/user_management`
   - `api_integration/auth0/provision_auth_schema`
   - `api_integration/auth0/setup_admin_permissions`
4. Execute `api_integration/auth0/provision_auth_schema` and wait until `COMPLETED`

### Current public deployment wiring

The current GKE profile keeps NoETL private and exposes only GUI and Gateway:

| Component | Public endpoint | In-cluster target | Notes |
|---|---|---|---|
| GUI | `https://mestumre.dev` | `gui.gui.svc.cluster.local` | Runtime config comes from `/env-config.js`. |
| Gateway | `https://gateway.mestumre.dev` | `gateway.gateway.svc.cluster.local` | CORS must allow the GUI origin. |
| NoETL API | none | `noetl.noetl.svc.cluster.local:8082` | ClusterIP only; Gateway proxies authenticated traffic. |
| PostgreSQL | none | `pgbouncer.postgres.svc.cluster.local:5432` | PgBouncer connects to Cloud SQL through the Cloud SQL Proxy sidecar. |

Required GUI runtime values for the gateway-backed mode:

```javascript
window.__NOETL_ENV__ = {
  VITE_API_MODE: "gateway",
  VITE_API_BASE_URL: "https://gateway.example.com/noetl",
  VITE_GATEWAY_URL: "https://gateway.example.com",
  VITE_ALLOW_SKIP_AUTH: "false",
  VITE_AUTH0_DOMAIN: "your-tenant.us.auth0.com",
  VITE_AUTH0_CLIENT_ID: "your-auth0-spa-client-id",
  VITE_AUTH0_REDIRECT_URI: "https://your-gui-domain/login"
};
```

Required Gateway settings:

```text
NOETL_BASE_URL=http://noetl.noetl.svc.cluster.local:8082
NATS_URL=nats://<user>:<password>@nats.nats.svc.cluster.local:4222
GATEWAY_PUBLIC_URL=https://gateway.example.com
CORS_ALLOWED_ORIGINS=https://your-gui-domain,https://gateway.example.com
GATEWAY_AUTH_BYPASS=false
```

Never enable `VITE_ALLOW_SKIP_AUTH=true` or `GATEWAY_AUTH_BYPASS=true` in this GKE profile.

## System playbook architecture

### High-level flow

```mermaid
flowchart TD
  Login["Auth0 login from Gateway"] --> P1["auth0_login"]
  P1 --> KV1["NATS KV: sessions"]
  P1 --> DB1["Postgres auth.sessions"]

  Validate["Session validate request"] --> P2["auth0_validate_session"]
  P2 --> DB2["Read Postgres source of truth"]
  P2 --> KV2["Refresh NATS session cache"]

  Access["Playbook permission check"] --> P3["check_playbook_access"]
  P3 --> RBAC["auth.user_roles + auth.playbook_permissions"]

  Admin["Admin UI role operations"] --> P4["user_management"]
  P4 --> RBAC
```

### Playbook responsibilities

| Playbook path | Purpose | Main dependencies | Typical output |
|---|---|---|---|
| `api_integration/auth0/provision_auth_schema` | Create `auth` schema/tables, seed roles/permissions | Postgres (`pg_auth`) | Schema + default RBAC data ready |
| `api_integration/auth0/setup_admin_permissions` | Seed wildcard playbook permissions, assign bootstrap admin roles | Postgres (`pg_auth`) | Admin/developer grants in `auth.playbook_permissions` and `auth.user_roles` |
| `api_integration/auth0/auth0_login` | Decode Auth0 JWT, upsert user/session, load roles, cache session | Postgres + NATS + Gateway callback | `session_token`, user identity, role list |
| `api_integration/auth0/auth0_validate_session` | Validate token against Postgres, refresh NATS cache | Postgres + NATS + Gateway callback | `valid=true/false` + user/session metadata |
| `api_integration/auth0/check_playbook_access` | Evaluate RBAC for requested playbook/action | Postgres + Gateway callback | `allowed=true/false` |
| `api_integration/auth0/user_management` | Admin operations for users/roles | Postgres + async callback | users list, roles list, role update result |

### Callback contracts used by Gateway

- Synchronous callback route: `POST /api/internal/callback`
  - Used by `auth0_login`, `auth0_validate_session`, `check_playbook_access`
- Async callback route: `POST /api/internal/callback/async`
  - Used by `user_management`
- Correlation field: `request_id`

Without `request_id`, most playbooks complete without callback and return local execution results only.

## Auth0 RBAC model for developers

### Core tables

- `auth.users`
- `auth.sessions`
- `auth.roles`
- `auth.permissions`
- `auth.user_roles`
- `auth.role_permissions`
- `auth.playbook_permissions`
- `auth.audit_log`

### Default roles seeded

- `admin`
- `developer`
- `analyst`
- `viewer`

### Path permission semantics (`check_playbook_access`)

A request is allowed when all are true:

1. Session token maps to active, non-expired session and active user
2. User has at least one active role
3. Role has a matching playbook permission where:
   - exact path matches, or `allow_pattern` matches
   - `deny_pattern` does not match
   - requested action flag is true (`can_execute`, `can_view`, `can_modify`)

## Developer runbook

### 1. Deploy or refresh stack

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml \
  --set action=deploy \
  --set project_id=<gcp-project-id> \
  --set cluster_name=<cluster-name>
```

### 2. Validate auth playbooks are registered

```bash
kubectl port-forward -n noetl svc/noetl 18082:8082

curl -s http://localhost:18082/api/catalog | jq '.resources[] | select(.path | startswith("api_integration/auth0/")) | .path'
```

If the auth playbooks need to be refreshed from the dedicated e2e repository:

```bash
cd repos/e2e
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/auth0_login.yaml
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/auth0_validate_session.yaml
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/check_playbook_access.yaml
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/user_management.yaml
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/provision_auth_schema.yaml
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/setup_admin_permissions.yaml
```

### 3. Register managed GKE MCP content

For the Google Cloud managed GKE MCP endpoint, register the runtime
agent and `Mcp` resource from `repos/ops`:

```bash
cd repos/ops

noetl --server-url http://localhost:18082 catalog register \
  automation/agents/gcp/runtime.yaml
noetl --server-url http://localhost:18082 catalog register \
  automation/agents/gcp/templates/mcp_gke_managed.yaml
```

The GUI terminal discovers this as `/mcp/gcp`. It does not call
Google Cloud directly; `status`, `tools`, and `call <tool>` start
NoETL executions for the `mcp/gcp/gke` agent playbook. The worker
needs Google Cloud credentials through Workload Identity, a
`GOOGLE_OAUTH_ACCESS_TOKEN` environment override, or a one-off
`workload.access_token` for local debugging. Prefer Workload Identity
with `roles/container.viewer`.

### 4. Validate schema/role data

```bash
kubectl exec -n postgres deploy/pgbouncer -- sh -lc 'echo "Use Cloud SQL client path for deep DB checks"'

# From any SQL client against the same DB used by pg_auth:
# SELECT role_name FROM auth.roles ORDER BY role_name;
# SELECT user_id, role_id FROM auth.user_roles ORDER BY user_id, role_id;
# SELECT role_id, allow_pattern, deny_pattern, can_execute, can_view, can_modify
# FROM auth.playbook_permissions ORDER BY role_id;
```

### 5. Verify session cache path

- Login through Gateway UI/API
- Confirm `auth.sessions` row exists in Postgres
- Confirm `sessions` bucket entry exists in NATS KV

### 6. Verify browser login through Gateway

Use an Auth0 ID token from the browser session or Auth0 tooling. Do not put passwords in shell commands or logs.

```bash
curl -i -X OPTIONS https://gateway.example.com/api/auth/login \
  -H "Origin: https://your-gui-domain" \
  -H "Access-Control-Request-Method: POST"

curl -i -X POST https://gateway.example.com/api/auth/login \
  -H "Origin: https://your-gui-domain" \
  -H "Content-Type: application/json" \
  --data '{"auth0_token":"<auth0-id-token>","auth0_domain":"your-tenant.us.auth0.com"}'
```

Expected login response:

```json
{
  "status": "authenticated",
  "session_token": "<opaque-session-token>",
  "user": {
    "user_id": 1,
    "email": "user@example.com",
    "display_name": "User Name",
    "roles": []
  },
  "expires_at": "2026-05-01T00:00:00",
  "message": "Authentication successful"
}
```

## Common pitfalls and fixes

### 1. DNS or host resolution errors for `pg_auth`

Symptom in execution events: `"[Errno -2] Name or service not known"`

Fix:

- Verify `pg_auth.data.db_host` matches reachable in-cluster service (`pgbouncer.postgres.svc.cluster.local` in Cloud SQL profile)
- Validate DNS from NoETL worker namespace
- Re-register credential if host/port changed

### 2. No callback received by Gateway

Fix:

- Ensure `request_id` is passed by caller
- Ensure `gateway_url` is reachable from worker (`http://gateway.gateway.svc.cluster.local` in-cluster)
- Verify callback route (`/api/internal/callback` vs `/api/internal/callback/async`)

### 3. `user_management` role updates fail on `granted_by`

`user_management.yaml` writes `auth.user_roles.granted_by`.
If the active schema was created only by the current lightweight `provision_auth_schema.yaml`, this column may be missing.

Remediation options:

1. Add column via migration:

```sql
ALTER TABLE auth.user_roles
ADD COLUMN IF NOT EXISTS granted_by BIGINT REFERENCES auth.users(user_id);
```

2. Or align `user_management.yaml` insert statement to current table definition.

### 4. Gateway login returns 401/500 or `Invalid email`

Symptoms:

- Browser login fails with `401`
- Gateway `/api/auth/login` returns `500 {"error":"Invalid email"}`
- Gateway logs show a successful NoETL callback, but the callback user payload is missing `email`
- NoETL worker logs show template errors around `prepare_session_cache.session_cache` or `prepare_session_cache.data.session_cache`

Cause:

`auth0_login.yaml` is a system playbook. It must match the current NoETL runtime result envelope. In current distributed runtime, Python step results are available to later steps through `prepare_session_cache.context.*` after state compaction. Older registered versions of the playbook addressed the prepared payload through `prepare_session_cache.session_cache.*` or `prepare_session_cache.data.*`, which produced a callback with null user fields. Gateway correctly rejected that callback as an invalid login payload.

Fix:

1. Register the current playbook from `repos/e2e`:

```bash
kubectl -n noetl port-forward svc/noetl 18082:8082
cd repos/e2e
noetl --server-url http://localhost:18082 register playbook \
  -f fixtures/playbooks/api_integration/auth0/auth0_login.yaml
```

2. Confirm the registered version is the newest catalog version:

```bash
curl -s http://localhost:18082/api/catalog/resource/api_integration/auth0/auth0_login | jq '{path, kind, version}'
```

3. Retry login and inspect Gateway logs:

```bash
kubectl -n gateway logs deployment/gateway --since=10m | rg "Auth login|callback|Invalid email"
```

4. If login still fails before the callback, confirm Cloud SQL grants for the NoETL database user. The auth playbooks need table, sequence, function, and schema privileges on the `auth` schema and the NoETL execution tables used by the runtime.

Do not test this path with real user passwords in terminal commands. Use the browser Auth0 flow, or use a short-lived ID token copied from the authenticated browser session.

## Related docs

- [Cloud SQL + PgBouncer (Private IP)](./gcp-cloudsql-pgbouncer-private-ip)
- [GKE Deployment Guide](./gke-deployment)
- [Gateway Auth0 Setup](../gateway/auth0-setup)
- [Gateway Deployment Guide](../gateway/deployment-guide)
- [IAP GKE Quick Start](../iap-gcp/gke_quick_start)
