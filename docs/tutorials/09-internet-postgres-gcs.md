---
title: 'Internet to Postgres to GCS'
sidebar_label: '09 - Internet to Postgres to GCS'
sidebar_position: 9
description: 'Create, register, and run a NoETL playbook that downloads public data, stores it in Postgres, then exports it to Google Cloud Storage.'
---

# Internet to Postgres to GCS

This tutorial builds one complete NoETL data movement flow:

1. Download JSON from a public internet API.
2. Store the response as `jsonb` in Postgres.
3. Read the saved Postgres row back.
4. Write a CSV export to Google Cloud Storage.
5. Register credentials, register the playbook, execute it, and check status with the NoETL CLI.

The runnable examples live in:

- `repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_hmac.yaml`
- `repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_workload_identity.yaml`

Use the HMAC playbook for local kind or any cluster where you want explicit
GCS credentials. Use the Workload Identity playbook on GKE when the NoETL
worker Kubernetes service account is already bound to a Google service
account with bucket write access.

## Prerequisites

- NoETL CLI installed and pointing at a running NoETL cluster.
- `jq` for shell examples.
- A Postgres database reachable from NoETL workers.
- A GCS bucket where the worker identity or registered GCS credential can write objects.

Never commit the credential files you create below. Keep them in `/tmp` or
another local-only secret location.

## Demo Path

Use this section for the current GKE demo cluster when the standard demo
credentials are already registered:

- NoETL API: `http://127.0.0.1:18082`
- Postgres credential: `pg_k8s`
- HMAC credential: `gcs_hmac_local`
- Workload Identity bucket: `noetl-demo-output`
- HMAC bucket: `noetl-demo-19700101`

Register both playbooks:

```bash
export NOETL_URL=http://127.0.0.1:18082

noetl --server-url "$NOETL_URL" register playbook \
  --file repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_workload_identity.yaml

noetl --server-url "$NOETL_URL" register playbook \
  --file repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_hmac.yaml
```

Expected registration output from the latest demo validation:

```text
Resource 'fixtures/playbooks/tutorials/internet_postgres_gcs/workload_identity' version '7' registered.
Resource 'fixtures/playbooks/tutorials/internet_postgres_gcs/hmac' version '6' registered.
```

Run the Workload Identity path:

```bash
WI_EXEC=$(noetl --server-url "$NOETL_URL" exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/workload_identity \
  --runtime distributed \
  --payload '{
    "pg_auth": "pg_k8s",
    "gcs_bucket": "noetl-demo-output",
    "gcs_prefix": "noetl/tutorial/demo-workload-identity"
  }' \
  --json | jq -r '.execution_id')

noetl --server-url "$NOETL_URL" status "$WI_EXEC" --json | jq '{
  execution_id,
  completed,
  failed,
  current_step,
  duration_human
}'
```

Validated output:

```json
{
  "execution_id": "627592523359191239",
  "completed": true,
  "failed": false,
  "current_step": "end",
  "duration_human": "6s"
}
```

Validated object:

```text
gs://noetl-demo-output/noetl/tutorial/demo-workload-identity/github_repo_627592523359191239.csv
```

Run the HMAC path:

```bash
HMAC_EXEC=$(noetl --server-url "$NOETL_URL" exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/hmac \
  --runtime distributed \
  --payload '{
    "pg_auth": "pg_k8s",
    "gcs_credential": "gcs_hmac_local",
    "gcs_bucket": "noetl-demo-19700101",
    "gcs_prefix": "noetl/tutorial/demo-hmac"
  }' \
  --json | jq -r '.execution_id')

noetl --server-url "$NOETL_URL" status "$HMAC_EXEC" --json | jq '{
  execution_id,
  completed,
  failed,
  current_step,
  duration_human
}'
```

Validated output:

```json
{
  "execution_id": "627592528442687692",
  "completed": true,
  "failed": false,
  "current_step": "end",
  "duration_human": "7s"
}
```

Validated object:

```text
gs://noetl-demo-19700101/noetl/tutorial/demo-hmac/github_repo_627592528442687692.csv
```

Verify all workflow commands completed:

```bash
noetl --server-url "$NOETL_URL" query \
  "SELECT execution_id, step_name, tool_kind, status, error::text AS error
   FROM noetl.command
   WHERE execution_id IN ('$WI_EXEC', '$HMAC_EXEC')
   ORDER BY execution_id, created_at" \
  --schema noetl \
  --format json
```

Expected result: every row has `status = "COMPLETED"` and `error = null`.
The latest validation returned completed rows for `insert_payload`,
`upload_csv_to_gcs`, and `export_postgres_to_gcs`.

Expected CSV content:

```text
execution_id,source_url,repo_name,repo_url,downloaded_at
627592523359191239,https://api.github.com/repos/noetl/noetl,noetl/noetl,https://github.com/noetl/noetl,2026-05-15T02:18:56Z
```

## How the Playbook Works

The HMAC playbook has seven steps:

| Step | Tool | Purpose |
|---|---|---|
| `create_table` | `postgres` | Creates `public.noetl_tutorial_downloads`. |
| `fetch_payload` | `python` | Downloads a small JSON record from `https://api.github.com/repos/noetl/noetl`. |
| `insert_payload` | `postgres` | Inserts one JSONB row. |
| `verify_postgres` | `postgres` | Counts rows for the current execution. |
| `export_postgres_to_gcs` | `duckdb` | Attaches Postgres and writes a CSV to `gs://...`. |
| `end` | `python` | Returns the generated GCS URI in the execution result. |

The Workload Identity playbook uses the same first four steps, then reads the
Postgres row with `read_postgres_for_export` and uploads CSV with
`upload_csv_to_gcs` using `google.cloud.storage` and the worker pod identity.
This avoids shipping a GCS key into the cluster.

The default workload values are safe placeholders. Override `pg_auth`,
`gcs_bucket`, and the GCS credential name at runtime.

## Local NoETL Cluster

This path assumes a local kind cluster and an API port-forward on
`localhost:8082`.

```bash
export NOETL_URL=http://localhost:8082

noetl context add local-kind --server-url "$NOETL_URL"
noetl context use local-kind
noetl context set-runtime distributed
```

If the API is not reachable, start a port-forward in another terminal:

```bash
kubectl -n noetl port-forward svc/noetl 8082:8082
```

### 1. Register Postgres Credentials

Create a local-only credential file. The values below match the common local
demo Postgres service shape; adjust them for your cluster.

```bash
cat >/tmp/pg_tutorial_local.json <<'JSON'
{
  "name": "pg_tutorial",
  "type": "postgres",
  "description": "Tutorial Postgres credential for local NoETL workers",
  "data": {
    "db_host": "postgres.postgres.svc.cluster.local",
    "db_port": "5432",
    "db_user": "demo",
    "db_password": "REPLACE_WITH_POSTGRES_PASSWORD",
    "db_name": "demo_noetl"
  }
}
JSON

noetl --server-url "$NOETL_URL" register credential --file /tmp/pg_tutorial_local.json
```

Confirm it is registered:

```bash
noetl --server-url "$NOETL_URL" catalog list credential --json \
  | jq -r '(.items // .)[]?.name' \
  | grep '^pg_tutorial$'
```

### 2. Register GCS HMAC Credentials

For local kind, use a GCS HMAC key because Workload Identity is not available.
The HMAC key needs permission to write to your tutorial bucket.

```bash
cat >/tmp/gcs_hmac_tutorial.json <<'JSON'
{
  "name": "gcs_hmac_tutorial",
  "type": "gcs_hmac",
  "description": "Tutorial GCS HMAC credential for DuckDB httpfs",
  "data": {
    "key_id": "REPLACE_WITH_GCS_HMAC_KEY_ID",
    "secret_key": "REPLACE_WITH_GCS_HMAC_SECRET",
    "type": "gcs",
    "service": "gcs"
  }
}
JSON

noetl --server-url "$NOETL_URL" register credential --file /tmp/gcs_hmac_tutorial.json
```

### 3. Register the Playbook

From the `ai-meta` workspace root:

```bash
noetl --server-url "$NOETL_URL" register playbook \
  --file repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_hmac.yaml
```

Expected output:

```text
Playbook registered successfully: ... "path":"fixtures/playbooks/tutorials/internet_postgres_gcs/hmac" ...
```

### 4. Execute the Playbook

Set your bucket name first:

```bash
export GCS_BUCKET=REPLACE_WITH_BUCKET_NAME

EXEC_ID=$(noetl --server-url "$NOETL_URL" exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/hmac \
  --runtime distributed \
  --payload "{
    \"pg_auth\": \"pg_tutorial\",
    \"gcs_credential\": \"gcs_hmac_tutorial\",
    \"gcs_bucket\": \"${GCS_BUCKET}\",
    \"gcs_prefix\": \"noetl/tutorial/local-kind\"
  }" \
  --json | jq -r '.execution_id')

echo "$EXEC_ID"
```

### 5. Check Execution Status

```bash
noetl --server-url "$NOETL_URL" status "$EXEC_ID" --json | jq '{
  execution_id,
  completed,
  failed,
  current_step,
  duration_human
}'
```

Wait until `completed` is `true` and `failed` is `false`.

### 6. Check Command Evidence with NoETL CLI

The `noetl query` command reads the NoETL control database. Use it to confirm
the Postgres insert and GCS export steps completed:

```bash
noetl --server-url "$NOETL_URL" query \
  "SELECT step_name, tool_kind, status, error::text AS error
   FROM noetl.command
   WHERE execution_id = '$EXEC_ID'
   ORDER BY created_at" \
  --schema noetl \
  --format json
```

Expected rows include `insert_payload`, `verify_postgres`, and
`export_postgres_to_gcs`, all with `status = "COMPLETED"` and `error = null`.
If the execution completed, the GCS write succeeded.

## GKE NoETL Cluster

For GKE, create a separate CLI context for the cluster. There are two supported
ways to reach the same NoETL API:

- **Gateway mode**: use `https://gateway.mestumre.dev` for normal
  authenticated access to the shared `mestumre.dev` cluster.
- **Direct port-forward mode**: use `http://localhost:18082` when you are
  debugging as a cluster operator and intentionally bypassing the public
  gateway.

### Recommended: gateway context for `mestumre.dev`

Use this mode when you want the CLI to behave like a user of the hosted
cluster. The context points at the gateway, and `noetl auth login` exchanges
your Auth0 login for a gateway session token cached in the local context.

```bash
export NOETL_URL=https://gateway.mestumre.dev

noetl context add mestumre-gke \
  --server-url "$NOETL_URL" \
  --runtime distributed \
  --auth0-domain mestumre-development.us.auth0.com \
  --auth0-client-id REPLACE_WITH_AUTH0_CLIENT_ID \
  --auth0-redirect-uri https://mestumre.dev/login \
  --set-current
```

Prefer the browser PKCE flow. It opens Auth0 in your browser and handles the
callback locally, so you do not need to copy an `id_token` by hand:

```bash
noetl auth login --browser-pkce
```

If PKCE is unavailable in your CLI build, use the browser/device flow:

```bash
noetl auth login --browser
```

Fallback manual token flow:

1. Open `https://mestumre.dev/login` and sign in with Auth0.
2. After Auth0 redirects back, copy the full browser URL from the address bar.
   It should look like `https://mestumre.dev/login#id_token=...`.
3. Paste that full callback URL into the CLI:

```bash
noetl auth login \
  --auth0-callback-url 'https://mestumre.dev/login#id_token=REPLACE_WITH_ID_TOKEN'
```

Do not commit or paste the real `id_token` into docs, shell history snippets, or
issue comments. It is a bearer token. Once login succeeds, use the gateway
context for the tutorial commands:

```bash
noetl --gateway catalog list credential
```

If your context URL is already `https://gateway.mestumre.dev`, gateway proxy
mode is auto-detected by recent CLI builds; `--gateway` is still useful as an
explicit signal in shared runbooks.

### Alternative: direct port-forward context

Use this mode when you have Kubernetes access and want direct admin/debug
access to the NoETL server service. The example below uses a local port-forward
on `18082` so it does not collide with local kind.

```bash
kubectl config use-context REPLACE_WITH_GKE_CONTEXT
kubectl -n noetl port-forward svc/noetl 18082:8082
```

In another terminal:

```bash
export NOETL_URL=http://localhost:18082

noetl context add gke-noetl --server-url "$NOETL_URL"
noetl context use gke-noetl
noetl context set-runtime distributed
```

### Option A: GKE with Workload Identity

Use this option when the NoETL worker Kubernetes service account can already
write to the target bucket through Workload Identity. No GCS credential is
registered in NoETL for this path.

Register the GKE Postgres credential. Use the in-cluster host that your GKE
NoETL deployment uses, for example PgBouncer or Cloud SQL proxy service DNS.

```bash
cat >/tmp/pg_tutorial_gke.json <<'JSON'
{
  "name": "pg_tutorial",
  "type": "postgres",
  "description": "Tutorial Postgres credential for GKE NoETL workers",
  "data": {
    "db_host": "REPLACE_WITH_GKE_POSTGRES_SERVICE",
    "db_port": "5432",
    "db_user": "REPLACE_WITH_POSTGRES_USER",
    "db_password": "REPLACE_WITH_POSTGRES_PASSWORD",
    "db_name": "REPLACE_WITH_POSTGRES_DATABASE"
  }
}
JSON

noetl --server-url "$NOETL_URL" register credential --file /tmp/pg_tutorial_gke.json
```

Register and execute the Workload Identity playbook:

```bash
noetl --server-url "$NOETL_URL" register playbook \
  --file repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_workload_identity.yaml

export GCS_BUCKET=REPLACE_WITH_BUCKET_NAME

EXEC_ID=$(noetl --server-url "$NOETL_URL" exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/workload_identity \
  --runtime distributed \
  --payload "{
    \"pg_auth\": \"pg_tutorial\",
    \"gcs_bucket\": \"${GCS_BUCKET}\",
    \"gcs_prefix\": \"noetl/tutorial/gke-workload-identity\"
  }" \
  --json | jq -r '.execution_id')

noetl --server-url "$NOETL_URL" status "$EXEC_ID" --json
```

Expected successful status shape:

```json
{
  "execution_id": "627592523359191239",
  "completed": true,
  "failed": false,
  "current_step": "end",
  "duration_human": "6s"
}
```

The GKE validation run used:

```bash
noetl --server-url http://127.0.0.1:18082 exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/workload_identity \
  --runtime distributed \
  --payload '{
    "pg_auth": "pg_k8s",
    "gcs_bucket": "noetl-demo-output",
    "gcs_prefix": "noetl/tutorial/gke-workload-identity"
  }'
```

It created:

```text
gs://noetl-demo-output/noetl/tutorial/demo-workload-identity/github_repo_627592523359191239.csv
```

If you see a 403 such as
`does not have storage.objects.create access`, the playbook is healthy but the
worker's Google service account does not have write permission on that bucket.

### Option B: GKE with Explicit GCS Credentials

Use this option when Workload Identity is not configured for the worker. The
credential registration is the same HMAC shape used by local kind:

```bash
cat >/tmp/gcs_hmac_tutorial.json <<'JSON'
{
  "name": "gcs_hmac_tutorial",
  "type": "gcs_hmac",
  "description": "Tutorial GCS HMAC credential for GKE NoETL workers",
  "data": {
    "key_id": "REPLACE_WITH_GCS_HMAC_KEY_ID",
    "secret_key": "REPLACE_WITH_GCS_HMAC_SECRET",
    "type": "gcs",
    "service": "gcs"
  }
}
JSON

noetl --server-url "$NOETL_URL" register credential --file /tmp/gcs_hmac_tutorial.json
```

Then register and execute the HMAC playbook against GKE:

```bash
noetl --server-url "$NOETL_URL" register playbook \
  --file repos/e2e/fixtures/playbooks/tutorials/internet_postgres_gcs/internet_postgres_gcs_hmac.yaml

EXEC_ID=$(noetl --server-url "$NOETL_URL" exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/hmac \
  --runtime distributed \
  --payload "{
    \"pg_auth\": \"pg_tutorial\",
    \"gcs_credential\": \"gcs_hmac_tutorial\",
    \"gcs_bucket\": \"${GCS_BUCKET}\",
    \"gcs_prefix\": \"noetl/tutorial/gke-hmac\"
  }" \
  --json | jq -r '.execution_id')

noetl --server-url "$NOETL_URL" status "$EXEC_ID" --json
```

Expected successful status shape:

```json
{
  "execution_id": "627592528442687692",
  "completed": true,
  "failed": false,
  "current_step": "end",
  "duration_human": "7s"
}
```

The GKE validation run used:

```bash
noetl --server-url http://127.0.0.1:18082 exec \
  fixtures/playbooks/tutorials/internet_postgres_gcs/hmac \
  --runtime distributed \
  --payload '{
    "pg_auth": "pg_k8s",
    "gcs_credential": "gcs_hmac_local",
    "gcs_bucket": "noetl-demo-19700101",
    "gcs_prefix": "noetl/tutorial/gke-hmac"
  }'
```

It created:

```text
gs://noetl-demo-19700101/noetl/tutorial/demo-hmac/github_repo_627592528442687692.csv
```

The command-table check for the successful HMAC run returned all tutorial
steps as `COMPLETED`, including `insert_payload` and
`export_postgres_to_gcs`.

## Troubleshooting

### Credential Not Found

```bash
noetl --server-url "$NOETL_URL" catalog list credential --json
```

The playbook defaults to `pg_tutorial` and `gcs_hmac_tutorial`. If you use
different names, pass them in the execution payload.

### Postgres Connection Fails

The Postgres host must be reachable from NoETL worker pods, not from your
laptop. Use Kubernetes service DNS such as
`postgres.postgres.svc.cluster.local`, `pgbouncer.postgres.svc.cluster.local`,
or the service name used by your GKE deployment.

### GCS Upload Fails

For HMAC mode, verify the registered HMAC key can write to the bucket. For
Workload Identity mode, verify the worker Kubernetes service account is bound
to a Google service account with `storage.objects.create` permission on the
bucket.
