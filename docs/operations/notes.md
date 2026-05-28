---
title: GKE Runbook Notes (Cloud SQL + PgBouncer)
sidebar_position: 4
description: Step-by-step runbook for building, deploying, authenticating, executing, and validating distributed playbooks on GKE.
---

# GKE Runbook Notes (Cloud SQL + PgBouncer)

This note captures the exact flow used to run distributed playbooks against:

- Project: `noetl-demo-19700101`
- Cluster: `us-central1/noetl-cluster`
- Gateway: `https://gateway.mestumre.dev`
- Database used by stress tests: `demo_noetl` (credential `pg_k8s`)

## 1) Build and install local CLI binary

```bash
cd /Volumes/X10/projects/noetl/noetl
cargo build -p noetl
cp ./target/debug/noetl bin/
cp ./target/debug/noetl .venv/bin/
which noetl
noetl --version
```

## 2) Deploy updated NoETL image to GKE (local runtime)

Use local runtime for this automation playbook (`executor.profile: local`).

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml --runtime local \
  --set action=deploy \
  --set project_id=noetl-demo-19700101 \
  --set region=us-central1 \
  --set cluster_name=noetl-cluster \
  --set build_images=true \
  --set build_noetl_image=true \
  --set build_gateway_image=false \
  --set build_gui_image=false \
  --set deploy_ingress=false \
  --set gateway_service_type=LoadBalancer \
  --set gateway_load_balancer_ip=34.46.180.136 \
  --set gui_service_type=LoadBalancer \
  --set gui_load_balancer_ip=35.226.162.30 \
  --set pgbouncer_default_pool_size=4 \
  --set pgbouncer_min_pool_size=1 \
  --set pgbouncer_reserve_pool_size=1 \
  --set pgbouncer_max_db_connections=8 \
  --set pgbouncer_server_idle_timeout=120
```

Verify public services after deploy:

```bash
kubectl get svc -n gateway gateway
kubectl get svc -n gui gui
```

Both services must have `EXTERNAL-IP` (not `<pending>` / `<none>`).

## 3) Bootstrap gateway auth (if required)

If auth resources are missing/stale, run:

```bash
noetl run automation/gcp_gke/noetl_gke_fresh_stack.yaml --runtime local \
  --set action=deploy \
  --set project_id=noetl-demo-19700101 \
  --set region=us-central1 \
  --set cluster_name=noetl-cluster \
  --set build_images=false \
  --set bootstrap_gateway_auth=true
```

## 4) Login

```bash
# Recommended — interactive browser PKCE
noetl auth login --browser-pkce --context gke-prod

# Or paste a full Auth0 callback URL
noetl auth login --context gke-prod --auth0-callback-url 'https://mestumre.dev/login#id_token=...'
```

A successful login caches the gateway session token onto the
context file (`~/.noetl/config.yaml`); subsequent CLI calls against
that context read it from there automatically. The
`export NOETL_SESSION_TOKEN=...` hint printed after login is for
**other tools** that read the env var (the curl examples in
section 9 below, for instance) — not for the CLI itself.

Notes:

- A short opaque token is not a JWT and will fail with `Invalid JWT format`.
- Use the full callback URL (`...#id_token=...`) or a valid JWT in the
  `--auth0-token` / `--auth0-callback-url` modes.
- Browser PKCE first-time setup requires the callback URI
  (`http://127.0.0.1:8765/callback`) to be in the Auth0 application's
  **Allowed Callback URLs**. The CLI prints the Auth0 dashboard URL
  for the application as part of its PKCE pre-flight so you can verify
  the allowlist before the browser opens.
- If a later CLI call against `gke-prod` exits with code **77**, the
  session expired — re-run the login above.

For curl-based DB queries against the gateway (section 9 below),
export the token from the context after login.  The CLI stores its
config as YAML at `~/.noetl/config.yaml`; pick whichever extractor
fits the tools you have:

```bash
# yq (preferred — reliable on YAML)
export NOETL_SESSION_TOKEN=$(yq -r '.contexts."gke-prod".gateway_session_token' \
  ~/.noetl/config.yaml)

# awk fallback (no yq required) — pulls the gateway_session_token
# from inside the gke-prod block.  Works because the serialized form
# is unquoted scalars and the contexts map is top-level.
export NOETL_SESSION_TOKEN=$(awk '
  /^  gke-prod:/{flag=1; next}
  /^  [a-z][a-z0-9_-]*:$/{flag=0}
  flag && /gateway_session_token:/{print $2; exit}
' ~/.noetl/config.yaml)
```

## 5) Verify and use context

```bash
noetl context list
noetl context use gke-prod                         # persistent switch
# or, per-command without changing the current context:
noetl --context gke-prod catalog list Playbook
```

## 6) Register playbooks

Register only target playbooks (faster, lower failure surface):

```bash
noetl register playbook --file tests/fixtures/playbooks/batch_execution/server_oom_stress_chunk_worker_v2/server_oom_stress_chunk_worker_v2.yaml
noetl register playbook --file tests/fixtures/playbooks/batch_execution/server_oom_stress_test_v2/server_oom_stress_test_v2.yaml
```

Bulk register (optional):

```bash
find tests/fixtures/playbooks -name '*.yaml' | sort > /tmp/playbooks.list
split -l 20 /tmp/playbooks.list /tmp/pb_chunk_
for f in /tmp/pb_chunk_*; do
  while IFS= read -r pb; do
    noetl register playbook --file "$pb" || break 2
  done < "$f"
done
```

## 7) Execute stress test

```bash
noetl exec catalog://tests/fixtures/playbooks/batch_execution/server_oom_stress_test_v2 \
  --runtime distributed \
  --payload '{"total_items":3000,"batch_size":50,"concurrent_batches":1,"items_max_in_flight":1}' \
  --json
```

Capture `execution_id` from output.

## 8) Check status and duration

Single check:

```bash
id="<execution_id>"
noetl execute status "$id" --json | jq '{
  completed,
  failed,
  current_step,
  duration_human,
  duration_seconds,
  batch:.variables.batch,
  summary:.variables.summarize
}'
```

Live watch:

```bash
watch -n 10 "noetl execute status $id --json | jq '{completed,failed,current_step,duration_human,duration_seconds,batch_number:.variables.batch.batch_number,batch_count:.variables.build_batch_plan.batch_count}'"
```

## 9) Validate DB results in `demo_noetl`

Use gateway PostgreSQL API with explicit credential and database:

```bash
curl -sS "https://gateway.mestumre.dev/noetl/postgres/execute" \
  -H "Authorization: Bearer $NOETL_SESSION_TOKEN" \
  -H "x-session-token: $NOETL_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"SELECT current_database() AS db, COUNT(*) AS cnt FROM public.stress_test_results;",
    "credential":"pg_k8s",
    "database":"demo_noetl",
    "schema":"public"
  }' | jq
```

Expected for the 3000-item run: `cnt = 3000`.

## 10) Payload correctness checks (JSONB)

```sql
SELECT pg_typeof(result_data) AS result_data_type
FROM public.stress_test_results
LIMIT 1;

SELECT
  item_id,
  (result_data ? 'payload') AS has_payload,
  left(result_data->>'payload', 60) AS payload_preview,
  ((result_data->'data'->>'field_000') IS NOT NULL) AS has_field_000,
  ((result_data->'data'->>'field_599') IS NOT NULL) AS has_field_599,
  (SELECT COUNT(*) FROM json_object_keys((result_data->'data')::json)) AS data_fields
FROM public.stress_test_results
ORDER BY item_id DESC
LIMIT 5;
```

Notes:

- Use `json_object_keys((... )::json)` if `jsonb_object_length(jsonb)` is unavailable.
- `noetl query` may use a different default DB; for this test use `/noetl/postgres/execute` with explicit `database`.

## 11) Known failure patterns and fixes

- `401 Unauthorized - Invalid JWT format`
  - Use full Auth0 callback URL or proper JWT token during `noetl auth login`.
- `404 Execution not found` on status
  - CLI now falls back to `/executions/{id}` event-log path; use latest binary.
- `405 Method Not Allowed` during auth bootstrap
  - Run automation with `--runtime local`; auth bootstrap must call NoETL API directly.
- Cloud SQL saturation / instability
  - Keep conservative PgBouncer settings (pool size 4/min 1/reserve 1/max db conns 8).
