---
sidebar_position: 10
title: CLI Reference
description: Complete guide for the NoETL command-line interface including all commands and runtime modes
---

# NoETL Command Line Interface (CLI) Guide

This guide provides detailed instructions for using the NoETL command-line interface.

## Overview

NoETL provides a unified command-line interface for executing playbooks with two runtime modes:

- **Local Runtime**: Execute playbooks directly using the Rust interpreter (no server required)
- **Distributed Runtime**: Execute playbooks via NoETL server-worker architecture

The main command is `noetl`, which provides:

- `noetl run` / `noetl exec` - Execute playbooks (local or distributed)
- `noetl status` - Check execution status
- `noetl cancel` - Cancel running executions
- `noetl context` - Manage execution contexts, Auth0 settings, managed kubectl tunnels
- `noetl auth login` - Authenticate against the gateway (browser PKCE, password grant, callback URL, raw token)
- `noetl server` - Manage NoETL server process
- `noetl worker` - Manage worker processes
- `noetl iap` - Infrastructure as Playbook commands
- `noetl db` - Database management commands
- `noetl k8s` - Kubernetes deployment commands
- `noetl build` - Build Podman images

Global flags (available on every subcommand):

- `--context <NAME>` - Run one command using the named context, without changing the current one.
- `--gateway` - Force gateway-proxy mode.
- `--session-token <TOKEN>` - Override the cached session token for one command.

## Quick Start

```bash
# Run a playbook (auto-detects runtime)
noetl run ./playbooks/my_workflow.yaml

# Run with explicit local runtime
noetl run ./playbooks/my_workflow.yaml -r local

# Run with variables
noetl run ./playbooks/my_workflow.yaml --set key=value --set env=prod

# Run with JSON payload
noetl run ./playbooks/my_workflow.yaml --payload '{"key": "value"}'

# Check execution status
noetl status <execution_id>

# Cancel a running execution
noetl cancel <execution_id> --reason "No longer needed"

# Set context default to local
noetl context set-runtime local

# Start the server (for distributed mode)
noetl server start

# Start a worker (for distributed mode)
noetl worker start
```

## Unified Run Command

The `noetl run` command is the primary way to execute playbooks:

```bash
noetl run <REF> [OPTIONS]
```

### Reference Types

| Format | Example | Default Runtime |
|--------|---------|-----------------|
| File path | `./playbooks/deploy.yaml` | local |
| Catalog URI | `catalog://my-playbook@1.0` | distributed |
| Catalog path | `workflows/etl-pipeline` | distributed |
| Database ID | `pbk_01J...` | distributed |

### Options

| Option | Description |
|--------|-------------|
| `-r, --runtime` | Runtime mode: `local`, `distributed`, or `auto` (default: auto) |
| `-t, --target` | Target step to start from (local runtime only) |
| `--set KEY=VALUE` | Set variables (can be repeated) |
| `--payload JSON` | Pass multiple variables as JSON object |
| `--workload JSON` | Alias for --payload |
| `-V, --version` | Catalog version (for catalog:// refs without @version) |
| `--endpoint` | Server endpoint for distributed runtime |
| `-v, --verbose` | Show detailed execution output |
| `--dry-run` | Validate and show plan without executing |
| `-j, --json` | Emit only JSON response (distributed runtime) |

### Examples

```bash
# Basic execution (auto runtime)
noetl run automation/deploy.yaml

# Force local execution
noetl run automation/deploy.yaml -r local

# Force distributed execution
noetl run catalog://my-playbook@1.0 -r distributed

# With target step
noetl run automation/tasks.yaml -t cleanup

# Individual variables
noetl run deploy.yaml --set env=prod --set version=v2.5.5

# JSON payload
noetl run deploy.yaml --payload '{"env":"production","debug":true}'

# Combined (--set overrides payload)
noetl run deploy.yaml \
  --payload '{"target":"staging","registry":"gcr.io"}' \
  --set target=production

# Verbose mode
noetl run automation/test.yaml -v

# Dry-run mode
noetl run automation/deploy.yaml --dry-run -v
```

## Runtime Resolution

Runtime is determined using this priority:

1. **Explicit flag**: `--runtime local` or `--runtime distributed`
2. **Context config**: From `noetl context set-runtime`
3. **Auto-detect**: Based on reference type (file → local, catalog:// → distributed)

### Setting Context Runtime

```bash
# Set default runtime for current context
noetl context set-runtime local
noetl context set-runtime distributed
noetl context set-runtime auto

# View current context
noetl context current
```

## Context Management

Contexts store server URLs, default runtime preferences, Auth0
application metadata, and (optionally) Kubernetes connection fields
for the managed port-forward daemon. The CLI exposes five
write-side commands plus the read-side `list / current / use /
delete / set-runtime`:

| Subcommand | Purpose |
|---|---|
| `context add` | Create a context from CLI flags. |
| `context init --from-gateway` | Bootstrap from the gateway's runtime contract (discovers Auth0 fields). |
| `context update` | Patch fields in place — no delete + re-add dance. |
| `context port-forward` | Start / stop / status a managed `kubectl port-forward` daemon. |
| `context set-runtime` | Change the default runtime on the current context. |

### Quick reference

```bash
# Add a new context from CLI flags
noetl context add local-dev \
  --server-url=http://localhost:8082 \
  --runtime=local \
  --set-current

# Bootstrap a gateway context — reads gateway /api/runtime/contract
noetl context init gke-prod --from-gateway https://gateway.mestumre.dev --set-current

# Patch any field after creation (Auth0 rotation, kube fields, runtime change)
noetl context update gke-prod --auth0-client-id=NewClientIdAfterRotation
noetl context update gke-prod --kube-context=gke_demo_us-central1_noetl-cluster \
                              --kube-namespace=noetl

# List / inspect / switch / delete
noetl context list
noetl context current
noetl context use prod
noetl context delete old-env
noetl context set-runtime local
```

### `noetl --context <name>` per-command override

For a single command against a non-current context, use the global
`--context <name>` flag (mirrors `kubectl --context` and
`gcloud --account`). The current context is unchanged:

```bash
noetl --context gke-prod catalog list Playbook
noetl --context gke-pf   register credential -f duffel.json
noetl --context smoke    exec ./playbooks/foo.yaml
```

### `noetl context init --from-gateway`

Discover Auth0 fields from the gateway in one command:

```bash
noetl context init <name> --from-gateway <gateway-url> [flags]
```

The CLI fetches `GET <gateway-url>/api/runtime/contract`, parses the
`auth0` block (`domain`, `client_id`, `redirect_uri`, `audience`),
prints what it's about to write, prompts for confirmation, and
writes the context. Use `--yes` (alias `--non-interactive`) to skip
the prompt in CI:

```bash
noetl context init gke-prod \
  --from-gateway https://gateway.mestumre.dev \
  --runtime distributed \
  --set-current

# CI variant
noetl context init gke-prod \
  --from-gateway https://gateway.mestumre.dev \
  --yes
```

If the gateway doesn't expose an `auth0` block (older image or
non-Auth0 deployment), the CLI writes `server_url` only and prints
a follow-up `noetl context update` invocation.

### `noetl context update`

Patch any field on an existing context in place. Every flag is
optional; omitted fields are preserved. Empty string clears Auth0 /
kube string fields; `--kube-remote-port=0` clears back to the
default of `8082`:

```bash
# Rotate Auth0 client_id without dropping the cached session token
noetl context update gke-prod --auth0-client-id=NewClientIdAfterRotation

# Point an existing port-forward context at a different local port
noetl context update gke-pf --server-url=http://127.0.0.1:18083

# Add kube fields so context port-forward will work
noetl context update gke-prod \
  --kube-context=gke_demo_us-central1_noetl-cluster \
  --kube-namespace=noetl

# Clear an audience that was set by mistake
noetl context update gke-prod --auth0-audience=""
```

The cached `gateway_session_token` is **not** touched by `context
update`.

### `noetl context port-forward`

Managed `kubectl port-forward` daemon for a context that has
`kube_context` + `kube_namespace` set. The local port comes from
the context's `server_url` (must be a loopback URL like
`http://127.0.0.1:18082`).

```bash
# Foreground — exits on Ctrl-C
noetl context port-forward gke-pf

# Background daemon — writes ~/.noetl/port-forwards/gke-pf.pid
noetl context port-forward gke-pf --detach

# Liveness check
noetl context port-forward gke-pf --status

# SIGTERM (500 ms grace) → SIGKILL → PID file cleanup
noetl context port-forward gke-pf --stop
```

Before spawning kubectl, the CLI probes the local port with a
`TcpListener::bind`. If the port is already in use, the CLI exits
with a diagnostic pointing to `lsof`, `fuser`, and
`pkill -f 'port-forward svc/noetl'` so you can identify the culprit.

### Gateway Context + Auth0 Login

For deployments behind a gateway (e.g. `https://gateway.mestumre.dev`):

```bash
# Modern path — discover Auth0 fields from the gateway
noetl context init gke-prod --from-gateway https://gateway.mestumre.dev --set-current

# Browser PKCE login (recommended interactive flow)
noetl auth login --browser-pkce

# gcloud-style browser/device flow (no callback copy/paste)
noetl auth login --browser

# Optional login hint and callback port override
noetl auth login --browser-pkce --auth0 user@example.com --pkce-port 8765

# Paste full Auth0 callback URL (legacy flow)
noetl auth login --auth0-callback-url 'https://mestumre.dev/login#id_token=...'
```

Then run authenticated commands through the gateway:

```bash
noetl --context gke-prod catalog register tests/fixtures/playbooks/quantum_cudaq/quantum_cudaq.yaml
noetl --context gke-prod exec tests/quantum/cudaq_ai_pipeline -r distributed
```

If your context URL is already a gateway URL (`gateway.*`),
gateway-proxy mode is auto-detected; `--gateway` remains available
as an explicit override.

For password grant without storing the secret in local config, pass
it per-command or via ephemeral env var:

```bash
noetl auth login --auth0 user@example.com --password --auth0-client-secret "$AUTH0_CLIENT_SECRET"
NOETL_AUTH0_CLIENT_SECRET="$AUTH0_CLIENT_SECRET" noetl auth login --auth0 user@example.com --password
```

#### PKCE callback details

- Default callback URI: `http://127.0.0.1:8765/callback`.
- Override with `--auth0-redirect-uri` (must be `localhost` or
  `127.0.0.1`).
- The Auth0 application must allow the callback URI in **Allowed
  Callback URLs**. The CLI prints a pre-flight notice with the
  exact URI and the Auth0 dashboard URL for the application, so
  you can verify the allowlist before the browser opens. If
  authentication hangs and the browser shows "Callback URL
  mismatch", add the URI shown in the pre-flight and retry.

#### After login: the session token is cached on the context

A successful `noetl auth login` writes the gateway session token
directly onto the context file (`~/.noetl/config.toml`):

```
Gateway login successful.
  Gateway: https://gateway.mestumre.dev
  User:    you@example.com
  Token:   69dd6f...2bc6
  Saved:   context 'gke-prod'

Use this session for CLI calls:
  export NOETL_SESSION_TOKEN='69dd6f8a7621ca3cd1e8924460842bc6'
```

Subsequent CLI calls against that context read the token from the
file automatically — you do **not** need to run the printed
`export` line for CLI usage. The env var is only useful for
external tools that read it (curl, ad-hoc scripts), or for one-off
commands where you don't want the token persisted.

Verify with a one-shot command:

```bash
noetl --context gke-prod catalog list Playbook
```

A list of playbooks means you're authenticated end-to-end.

#### Exit code 77 — gateway session expired

When any CLI command receives a 401 from the gateway using a cached
session token, the CLI exits with code **77** and prints:

```
Gateway returned 401 (session expired) for context 'gke-prod'.
  Refresh the session token:  noetl auth login --browser-pkce
```

Scripts can branch on the exit code to auto-trigger a re-login:

```bash
noetl --context gke-prod catalog list Playbook || code=$?
if [[ "${code:-0}" -eq 77 ]]; then
    noetl auth login --browser-pkce --context gke-prod
    noetl --context gke-prod catalog list Playbook
fi
```

### Common Context Workflows

**Setup Kind cluster context for registering playbooks/credentials:**
```bash
# Add context for Kind cluster with distributed runtime
noetl context add kind-cluster --server-url http://localhost:8082
noetl context use kind-cluster
noetl context set-runtime distributed

# Now register playbooks and credentials
noetl register playbook tests/fixtures/playbooks/
noetl register credential tests/fixtures/credentials/
```

**Switch between local development and distributed execution:**
```bash
# For local playbook development (no server needed)
noetl context add local-dev --server-url http://localhost:8082
noetl context use local-dev
noetl context set-runtime local
noetl run automation/my_playbook.yaml -v

# For distributed execution (requires Kind cluster running)
noetl context use kind-cluster
noetl context set-runtime distributed
noetl run catalog/path/to/playbook --set env=production
```

**IaP development context (always local):**
```bash
# IaP playbooks always run locally with Rhai scripting
noetl context add iap-gcp --server-url http://localhost:8082
noetl context use iap-gcp
noetl context set-runtime local
noetl iap apply automation/iap/gcp/gke_autopilot.yaml --auto-approve --var action=create
```

## Console Mode (REPL)

Start a persistent prompt and run CLI commands without exiting to the OS shell:

```bash
noetl console
```

Prompt displays active connection:
- `noetl(<context>@<server>|api)>` direct API mode
- `noetl(<context>@<server>|gw)>` gateway proxy mode

Useful console commands:

```bash
help
where
context use gke-prod
catalog list Playbook --json
exec tests/quantum/cudaq_ai_pipeline -r distributed
exit
```

## Playbook Executor Section

Playbooks can declare their execution requirements:

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: my_automation
  path: automation/my-task

executor:
  profile: local           # Preferred runtime: local or distributed
  version: noetl-runtime/1 # Runtime version compatibility
  requires:                # Optional: required tools/features
    tools:
      - shell
      - http
    features:
      - templating

workflow:
  - step: start
    tool:
      kind: shell
      cmds:
        - echo "Hello World"
```

## Running the NoETL Server

For distributed execution, start the server:

```bash
noetl server start
```

Options:
- `--init-db`: Initialize database schema on startup

Example:
```bash
noetl server start --init-db
```

Stop the server:
```bash
noetl server stop
noetl server stop --force
```

## Execution Management

### Checking Execution Status

Check the status of a running or completed execution:

```bash
# Basic status check
noetl status <execution_id>

# JSON output
noetl status <execution_id> --json
```

Example output:
```
============================================================
Execution: 543857817971589380
Status:    RUNNING
Steps:     3 completed
Current:   process_data

Completed steps:
  - start
  - fetch_data
  - validate
============================================================
Use --json for full execution details
```

### Cancelling Executions

Cancel a running execution to stop it from processing further:

```bash
# Basic cancellation
noetl cancel <execution_id>

# With a reason
noetl cancel <execution_id> --reason "No longer needed"

# Cascade to child executions (sub-playbooks)
noetl cancel <execution_id> --cascade

# JSON output
noetl cancel <execution_id> --json
```

Options:
- `-r, --reason`: Provide a reason for cancellation (logged in the event)
- `--cascade`: Also cancel child executions spawned by sub-playbook calls
- `-j, --json`: Output JSON response only

Example output:
```
============================================================
Execution: 543857931469455628
Status:    CANCELLED
Cancelled: 1 execution(s)
Message:   Cancelled 1 execution(s)
Reason:    No longer needed
============================================================
```

Use cases:
- **Infinite loops**: Stop runaway workflows that have entered an infinite loop
- **Long-running jobs**: Abort jobs that are no longer needed
- **Hierarchical workflows**: Cancel parent execution and all spawned sub-playbooks

See [Execution Cancellation](../features/execution_cancellation) for detailed documentation.

## Worker Management

Workers execute playbooks in distributed mode:

### Starting Workers

```bash
# Start a worker with default settings
noetl worker start

# Start a worker with custom pool size
noetl worker start --max-workers 4
```

### Stopping Workers

```bash
# Interactive stop (shows menu if multiple workers)
noetl worker stop

# Stop specific worker by name
noetl worker stop --name worker-cpu-01

# Force stop without confirmation
noetl worker stop --name worker-gpu-01 --force
```

## Infrastructure as Playbook (IaP)

Manage cloud infrastructure using playbooks:

```bash
# Initialize state
noetl iap init --project my-gcp-project --bucket my-state-bucket

# Execute infrastructure playbooks
noetl iap apply automation/iap/gcp/gke_autopilot.yaml --auto-approve --var action=create

# Manage state
noetl iap state list
noetl iap state show my-cluster
noetl iap state query "SELECT * FROM resources"

# Sync state
noetl iap sync push
noetl iap sync pull
noetl iap sync status

# Workspace management
noetl iap workspace list
noetl iap workspace create dev-alice
noetl iap workspace switch production
```

## Catalog Management

### Registering Resources

```bash
# Register a playbook
noetl register playbook --file playbook.yaml

# Register from directory
noetl register playbook --directory tests/fixtures/playbooks

# Register credentials
noetl register credential --file credentials/postgres.json

# Register an executable agent playbook
noetl catalog register automation/agents/kubernetes/runtime.yaml --resource-type agent
```

### Querying Catalog

```bash
# List playbooks
noetl catalog list playbook

# List agent playbooks
noetl catalog list agent

# List credentials
noetl catalog list credential --json

# Get specific resource
noetl catalog get my-playbook
```

## Database Management

```bash
# Initialize database schema
noetl db init

# Validate database schema
noetl db validate
```

## Kubernetes Deployment

```bash
# Deploy to kind cluster
noetl k8s deploy

# Rebuild and redeploy
noetl k8s redeploy
noetl k8s redeploy --no-cache

# Reset: rebuild, redeploy, reset schema
noetl k8s reset

# Remove from cluster
noetl k8s remove
```

## Build Commands

```bash
# Build Podman image
noetl build

# Build without cache
noetl build --no-cache

# Build for specific platform
noetl build --platform linux/arm64
```

## Variable Priority

When running playbooks, variables are resolved in this order (highest to lowest):

1. `--set` parameters (individual overrides)
2. `--payload` / `--workload` (JSON object)
3. Playbook `workload` section (defaults)

## Local Runtime Tools

The local runtime supports these tool kinds:

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands |
| `http` | Make HTTP requests |
| `playbook` | Call sub-playbooks |
| `rhai` | Embedded scripting with Rhai |

## Getting Help

```bash
# General help
noetl --help

# Command-specific help
noetl run --help
noetl context --help
noetl iap --help
noetl server --help
```

## Next Steps

- [Local Execution Guide](/docs/cli/local_execution) - Detailed local runtime documentation
- [Infrastructure as Playbook](/docs/features/infrastructure_as_playbook) - Manage cloud infrastructure
- [Playbook Structure](/docs/reference/dsl/playbook_structure) - Learn playbook YAML structure
- [API Usage Guide](/docs/reference/api_usage) - REST API documentation
