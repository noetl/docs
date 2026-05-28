---
sidebar_position: 0
title: Overview
description: NoETL command-line tool for development and automation
---

# NoETL CLI Overview

The `noetl` CLI is a Rust-based command-line tool maintained in
`https://github.com/noetl/cli`. It provides a unified interface for executing
playbooks either locally or via distributed server-worker architecture.

## Unified Execution Model

NoETL uses a single `noetl run` command that can execute playbooks in two modes:

- **Local Runtime**: Execute directly using the Rust interpreter (no server required)
- **Distributed Runtime**: Execute via NoETL server-worker architecture

The runtime is selected automatically based on context or can be explicitly specified.

## Core Capabilities

### 1. Playbook Execution

Run NoETL playbooks with automatic runtime selection:

```bash
# Basic execution (runtime auto-detected based on context)
noetl run automation/deploy.yaml

# Force local execution (Rust interpreter, no server)
noetl run automation/deploy.yaml -r local

# Force distributed execution (server-worker)
noetl run catalog://my-playbook@1.0 -r distributed

# With variables
noetl run automation/deploy.yaml --set env=prod --set version=v2.5

# With JSON payload
noetl run automation/deploy.yaml --payload '{"env":"staging","debug":true}'

# Verbose output
noetl run automation/deploy.yaml -v
```

For distributed catalog execution, CLI overrides are merged into the
execution workload sent to the server. Both forms below set the same workload
fields:

```bash
noetl exec catalog://fixtures/playbooks/pft_flow_test/test_pft_flow_v2@8 \
  --runtime distributed \
  --set num_facilities=1 \
  --set patients_per_facility=10

noetl exec catalog://fixtures/playbooks/pft_flow_test/test_pft_flow_v2@8 \
  --runtime distributed \
  --set workload.num_facilities=1 \
  --set workload.patients_per_facility=10
```

Use `--payload '{"num_facilities":1}'` for larger JSON payloads; repeated
`--set` values override payload fields. Dotted `--set` keys create nested JSON
objects, except the leading `workload.` prefix is treated as an alias for the
root workload object.

**Runtime Resolution Priority**:
1. `--runtime` / `-r` flag (explicit: `local` or `distributed`)
2. Context configuration (`noetl context set-runtime`)
3. Auto-detect from reference type (file path → local, catalog:// → distributed)

### 2. Reference Types

The `noetl run` command accepts multiple reference formats:

| Format | Example | Default Runtime |
|--------|---------|-----------------|
| File path | `./playbooks/deploy.yaml` | local |
| Catalog URI | `catalog://my-playbook@1.0` | distributed |
| Catalog path | `workflows/etl-pipeline` | distributed |
| Database ID | `pbk_01J...` | distributed |

### 3. Context Management

Contexts store server URLs, default runtime preferences, Auth0
application metadata, and (optionally) Kubernetes connection fields
for the managed port-forward daemon.

```bash
# Add a context from CLI flags
noetl context add local-dev --server-url=http://localhost:8082 --runtime=local

# Bootstrap a context by reading the gateway's runtime contract
# (discovers Auth0 client_id/redirect_uri/audience for you)
noetl context init gke-prod --from-gateway https://gateway.mestumre.dev --set-current

# Patch fields in place (no delete + re-add dance)
noetl context update gke-prod --auth0-client-id=NewClientIdAfterRotation
noetl context update gke-prod --kube-context=gke_demo_us-central1_noetl-cluster \
                              --kube-namespace=noetl

# Set runtime for current context
noetl context set-runtime local
noetl context set-runtime distributed
noetl context set-runtime auto

# View current context
noetl context current

# Switch contexts
noetl context use prod

# Manage kubectl port-forward as a daemon for a context that has
# kube_* fields set
noetl context port-forward gke-pf --detach    # background, PID file
noetl context port-forward gke-pf --status    # PID + liveness
noetl context port-forward gke-pf --stop      # kill + cleanup
```

#### Gateway + Auth0: one-command bootstrap

`noetl context init --from-gateway` reads the gateway's
`GET /api/runtime/contract`, parses the `auth0` block, prints a
confirmation table, and writes the context — so you don't have to
look up Auth0 application IDs in the Auth0 dashboard.

```bash
# Discover + write context in one command
noetl context init gke-prod \
  --from-gateway https://gateway.mestumre.dev \
  --runtime distributed \
  --set-current

# Then log in (caches session token onto the context)
noetl auth login --browser-pkce

# gcloud-style browser/device login (no token copy)
noetl auth login --browser

# Optional login hint and callback port override
noetl auth login --browser-pkce --auth0 user@example.com --pkce-port 8765
```

If the gateway image is older than v2.10 (no Auth0 exposure on the
runtime contract), fall back to `noetl context add` with the Auth0
fields supplied directly, or use `noetl context update` after
`context init` to fill in what the contract didn't include.

#### PKCE flow notes

- Default callback URI is `http://127.0.0.1:8765/callback`.
- Override callback URI using `--auth0-redirect-uri`; it must use
  `localhost` or `127.0.0.1`.
- The Auth0 application must allow the callback URI in **Allowed
  Callback URLs**. The CLI prints the Auth0 dashboard URL for the
  application as part of its PKCE pre-flight so you can verify
  this before the browser opens. If Auth0 rejects with "Callback
  URL mismatch", add the URI shown in the pre-flight and retry.

#### Per-command context override

For a single command against a non-current context, use the global
`--context <name>` flag — mirrors `kubectl --context` and
`gcloud --account`:

```bash
noetl --context gke-prod catalog list Playbook
noetl --context gke-pf   register credential -f duffel.json
noetl --context smoke    exec ./playbooks/foo.yaml
```

The current context is unchanged.

#### After login: no need to `export NOETL_SESSION_TOKEN`

A successful `noetl auth login` caches the gateway session token
directly onto the context file (`~/.noetl/config.yaml`). Subsequent
CLI calls read it from there automatically. The
`export NOETL_SESSION_TOKEN=...` hint printed after login is for
**other tools** (curl, scripts) that read the env var — not for the
CLI itself.

#### Exit code 77 — gateway session expired

When the gateway returns 401 to a request that used a cached session
token, the CLI exits with code **77** and prints a re-login hint.
Scripts can branch on the exit code:

```bash
noetl --context gke-prod catalog list Playbook || code=$?
if [[ "${code:-0}" -eq 77 ]]; then
    noetl auth login --browser-pkce --context gke-prod
    noetl --context gke-prod catalog list Playbook
fi
```

**Common Context Workflows:**

```bash
# Setup Kind cluster context for registering playbooks/credentials
noetl context add kind-cluster --server-url http://localhost:8082
noetl context use kind-cluster
noetl context set-runtime distributed

# Register all test playbooks and credentials
noetl register playbook tests/fixtures/playbooks/
noetl register credential tests/fixtures/credentials/

# Switch back to local for development
noetl context use local-dev
noetl context set-runtime local
```

### 4. Auto-Discovery

When no playbook file is specified, `noetl run` searches for playbooks in the current directory:

```bash
# Auto-discover playbook and run target
noetl run bootstrap

# Run with auto-discovery (finds ./noetl.yaml or ./main.yaml)
noetl run

# Auto-discover with variables
noetl run deploy --set env=prod --set version=v2.5 --verbose
```

**Auto-Discovery Priority**:
1. `./noetl.yaml` (priority)
2. `./main.yaml` (fallback)

Perfect for:
- Build automation (replacing Make/Task)
- CI/CD pipelines
- Development scripts
- API testing

[Learn more →](./local_execution.md)

### 5. Process Management

Start and manage NoETL server and worker processes:

```bash
# Start server
noetl server start --init-db

# Start worker
noetl worker start

# Stop services
noetl server stop
noetl worker stop
```

[Learn more →](./architecture.md)

### 6. Resource Management

Register and manage NoETL resources:

```bash
# Register playbook
noetl register playbook --file playbook.yaml

# Register credential
noetl register credential --type postgres --name my_db

# List catalog
noetl catalog list playbooks
```

### 7. Development Tools

Kubernetes and database management:

```bash
# Deploy to kind cluster
noetl k8s deploy
noetl k8s redeploy
noetl k8s reset

# Database management
noetl db init
noetl db validate
```

### 8. Infrastructure as Playbook (IaP)

Manage cloud infrastructure using playbooks (Terraform alternative):

```bash
# Initialize state
noetl iap init --project my-gcp-project --bucket my-state-bucket

# Execute infrastructure playbooks
noetl iap apply automation/iap/gcp/gke_autopilot.yaml --auto-approve --var action=create

# Manage state
noetl iap state list
noetl iap sync push
noetl iap sync pull
```

```bash
# Deploy to kind cluster
noetl k8s deploy
noetl k8s redeploy
noetl k8s reset

# Database management
noetl db init
noetl db validate
```

### 9. Console Prompt Mode

Use a built-in command prompt to run multiple CLI commands without leaving the terminal session:

```bash
noetl console
```

Inside console:

```bash
where
context use gke-prod
--gateway catalog register tests/fixtures/playbooks/quantum_cudaq/quantum_cudaq.yaml
exec tests/quantum/cudaq_ai_pipeline -r distributed
exit
```

## Installation

Multiple installation options available:

### Package Managers (Recommended)

```bash
# macOS - Homebrew
brew tap noetl/tap
brew install noetl

# Ubuntu/Debian - APT
echo 'deb [trusted=yes] https://noetl.github.io/apt jammy main' | sudo tee /etc/apt/sources.list.d/noetl.list
sudo apt-get update
sudo apt-get install noetl

# Rust - Crates.io
cargo install --bins noetl
```

### Build from Source

```bash
git clone https://github.com/noetl/cli.git
cd cli
cargo build --release

# Binary available at:
# target/release/noetl
```

### Binary Locations

```bash
# After Homebrew install
/opt/homebrew/bin/noetl  # macOS Apple Silicon
/usr/local/bin/noetl     # macOS Intel

# After APT install
/usr/bin/noetl

# After cargo install
~/.cargo/bin/noetl

# After pip install
~/.local/bin/noetl  # Linux
~/Library/Python/3.x/bin/noetl  # macOS
```

**See**: [Installation Guide](../installation/homebrew.md) for complete details.

## Runtime Modes

### Local Runtime

Execute playbooks directly using the Rust interpreter without requiring any infrastructure:

```bash
# Local execution (explicit)
noetl run automation/tasks.yaml -r local

# Local execution (via context)
noetl context set-runtime local
noetl run automation/tasks.yaml
```

**Requirements**: None (just the binary)  
**Use Case**: Automation, scripts, CI/CD, development

**Supported Tools**: shell, http, playbook, rhai (embedded scripting)

### Distributed Runtime

Execute playbooks via the NoETL server-worker architecture:

```bash
# Start infrastructure
noetl server start
noetl worker start

# Distributed execution
noetl run catalog://my-playbook@1.0 -r distributed
```

**Requirements**: PostgreSQL, NATS (optional), ClickHouse (optional)  
**Use Case**: Production workflows, data pipelines

**Supported Tools**: All tools including postgres, duckdb, snowflake, container, etc.

### Auto Runtime

Let the CLI choose the runtime based on reference type:

```bash
# Set context to auto
noetl context set-runtime auto

# File paths → local runtime
noetl run ./playbook.yaml  # Uses local

# Catalog references → distributed runtime
noetl run catalog://my-playbook@1.0  # Uses distributed
```

## Playbook Executor Section

Playbooks can declare their execution requirements using the `executor` section:

```yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: my_automation
  path: automation/my-task

# Executor section declares runtime requirements
executor:
  profile: local           # local or distributed
  version: noetl-runtime/1 # Runtime version

workflow:
  - step: start
    tool:
      kind: shell
      cmds:
        - echo "Hello World"
```

**Executor Fields**:
- `profile`: Preferred execution profile (`local` or `distributed`)
- `version`: Runtime version compatibility
- `requires`: Optional tool/feature requirements for validation

## Context Configuration

Contexts allow you to configure default behaviors for different environments:

```bash
# Create a local development context
noetl context add local-dev \
  --server-url=http://localhost:8082 \
  --runtime=local \
  --set-current

# Create a production context
noetl context add prod \
  --server-url=https://noetl.prod.example.com \
  --runtime=distributed

# Switch between contexts
noetl context use local-dev
noetl context use prod

# View all contexts
noetl context list

# Change runtime for current context
noetl context set-runtime local
noetl context set-runtime distributed
noetl context set-runtime auto
```

**Context Configuration File**: `~/.noetl/config.yaml`

The CLI uses `--<flag>` names for input (e.g. `--auth0-domain`), but
the serialized form on disk uses snake_case with a `gateway_`
prefix for the auth0 / session fields. Inspect with
`noetl context current` or `noetl context list` rather than reading
the file by hand.

```yaml
current_context: local-dev

contexts:
  local-dev:
    server_url: http://localhost:8082
    runtime: local

  prod:
    server_url: https://noetl.prod.example.com
    runtime: distributed

  gke-prod:
    server_url: https://gateway.mestumre.dev
    runtime: distributed
    gateway_session_token: <cached-after-noetl-auth-login>
    gateway_auth0_domain: mestumre-development.us.auth0.com
    gateway_auth0_client_id: <client-id>
    gateway_auth0_redirect_uri: https://mestumre.dev/login
    gateway_auth0_audience: null
    gateway_auth0_client_secret: null
    kube_context: null
    kube_namespace: null
    kube_service: null
    kube_remote_port: null

  gke-pf:
    server_url: http://127.0.0.1:18082
    runtime: distributed
    kube_context: gke_demo_us-central1_noetl-cluster
    kube_namespace: noetl
    kube_service: noetl           # default
    kube_remote_port: 8082        # default
```

Additionally, the managed port-forward daemon writes PID files to
`~/.noetl/port-forwards/<context>.pid` — one per context.

## Command Categories

| Category | Commands | Purpose |
|----------|----------|---------|
| **Execution** | `run`, `exec` | Execute playbooks (local or distributed) |
| **Context** | `context add/init/update/use/list/current/delete/set-runtime/port-forward` | Manage execution contexts and managed kubectl tunnels |
| **Auth** | `auth login` (`--browser-pkce`, `--browser`, `--password`, callback URL, raw token) | Authenticate against the gateway |
| **Server** | `server start/stop` | Manage server process |
| **Worker** | `worker start/stop` | Manage worker process |
| **Register** | `register playbook/credential` | Add resources to catalog |
| **Catalog** | `catalog list/get/register` | Query registered resources |
| **K8s** | `k8s deploy/redeploy/remove/reset` | Kubernetes operations |
| **Database** | `db init/validate` | Database management |
| **IaP** | `iap init/plan/apply/state/sync/workspace` | Infrastructure as Playbook |

**Global flags**:

| Flag | Purpose |
|---|---|
| `--context <NAME>` | Run one command using the named context, without changing the current one. |
| `--gateway` | Force gateway-proxy mode. |
| `--session-token <TOKEN>` | Override the cached session token for one command. |

## Quick Start Examples

### Build Automation

**Example**: `automation/boot.yaml`

```yaml
# automation/boot.yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: noetl_boot
  path: automation/boot

executor:
  profile: local
  version: noetl-runtime/1

workflow:
  - step: start
    tool:
      kind: playbook
      path: setup/bootstrap.yaml
```

```bash
noetl run automation/boot.yaml
# or simply:
noetl run boot
```

Bootstrap builds only the Python server/worker image. Build Rust binaries separately and set `--set build_rust_cli=true` only when needed.

### API Testing

**File**: [`automation/examples/http_example.yaml`](https://github.com/noetl/noetl/blob/master/automation/examples/http_example.yaml)

```yaml
# automation/api_test.yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: api_tests

executor:
  profile: local
  version: noetl-runtime/1

workload:
  api_url: "http://localhost:8080"

workflow:
  - step: start
    next:
      - step: health_check
  
  - step: health_check
    tool:
      kind: http
      url: "{{ workload.api_url }}/health"
```

```bash
noetl run automation/api_test.yaml --verbose
```

### Multi-Stage Deployment

**Files**: [`automation/examples/parent_playbook.yaml`](https://github.com/noetl/noetl/blob/master/automation/examples/parent_playbook.yaml), [`build_child.yaml`](https://github.com/noetl/noetl/blob/master/automation/examples/build_child.yaml), [`deploy_child.yaml`](https://github.com/noetl/noetl/blob/master/automation/examples/deploy_child.yaml)

```yaml
# automation/deploy.yaml
apiVersion: noetl.io/v2
kind: Playbook
metadata:
  name: deployment

workflow:
  - step: build
    tool:
      kind: playbook
      path: ./build.yaml
  
  - step: test
    tool:
      kind: playbook
      path: ./test.yaml
  
  - step: deploy
    tool:
      kind: playbook
      path: ./k8s-deploy.yaml
```

```bash
noetl run automation/deploy.yaml
```

## Available Examples

Complete working examples in `automation/examples/`:

| Example File | Description | Key Features |
|--------------|-------------|--------------|
| `http_example.yaml` | HTTP GET/POST requests | Query params, result capture, vars extraction |
| `parent_playbook.yaml` | Playbook composition | Sub-playbook calls, args passing |
| `build_child.yaml` | Child playbook | Receives args as workload vars |
| `deploy_child.yaml` | Child playbook | Template rendering |
| `conditional_flow.yaml` | Conditional routing | case/when/then/else, comparison operators |
| `unsupported_tools.yaml` | Tool compatibility | Shows unsupported tool warnings |

**Try them**:
```bash
cd /path/to/noetl
noetl run automation/examples/http_example.yaml --verbose
noetl run automation/examples/parent_playbook.yaml --verbose
noetl run automation/examples/conditional_flow.yaml --set workload.environment=staging --verbose
noetl run automation/examples/unsupported_tools.yaml --verbose
```

## Documentation Structure

- **[Architecture & Usage](./architecture.md)** - When to use the CLI vs REST/API automation
- **[Local Execution](./local_execution.md)** - Complete guide with detailed examples and file references
- **Command Reference** (coming soon) - Full CLI command documentation
- **Advanced Examples** (coming soon) - Complex automation patterns

## Run Command Reference

Execute playbooks with automatic or explicit runtime selection:

```bash
noetl run <REF> [OPTIONS]

# Arguments
<REF>                Playbook reference (file path, catalog://, db ID, or catalog path)

# Options
-r, --runtime        Runtime mode: local, distributed, or auto (default: auto)
-t, --target         Target step to start from (local runtime only)
--set <KEY=VALUE>    Set variables (can be used multiple times)
--payload <JSON>     Pass multiple variables as JSON object
--workload <JSON>    Alias for --payload
-V, --version        Catalog version (for catalog:// refs without @version)
--endpoint           Server endpoint for distributed runtime
-v, --verbose        Show detailed execution output
--dry-run            Validate and show plan without executing
-j, --json           Emit only JSON response (distributed runtime)
```

**Examples**:

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

**Runtime Resolution**:
1. `--runtime local|distributed` (explicit flag)
2. Context config runtime (from `noetl context set-runtime`)
3. Auto-detect from reference type (file path → local, catalog:// → distributed)

**Variable Priority** (highest to lowest):
1. `--set` parameters (individual overrides)
2. `--payload` / `--workload` (JSON object)
3. Playbook `workload` section (defaults)

## Get Help

```bash
# General help
noetl --help

# Command-specific help
noetl run --help
noetl context --help
noetl server --help
noetl iap --help
```

## Next Steps

- [Learn about local playbook execution with detailed examples](./local_execution.md)
- [Understand architecture patterns](./architecture.md)
- [Infrastructure as Playbook guide](../features/infrastructure_as_playbook.md)
- Try examples in `automation/examples/` directory
- View example files: [http_example.yaml](https://github.com/noetl/noetl/blob/master/automation/examples/http_example.yaml), [parent_playbook.yaml](https://github.com/noetl/noetl/blob/master/automation/examples/parent_playbook.yaml)
