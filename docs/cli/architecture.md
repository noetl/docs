---
sidebar_position: 1
title: Architecture & Usage
description: Understanding when to use noetl CLI vs Python direct execution
---

# noetl CLI Architecture and Usage Patterns

## Overview

NoETL provides two ways to run the server and worker:

1. **noetl CLI (Rust CLI)** - Process manager and CLI tool for local development
2. **Python direct** - Direct execution via `python -m noetl.server` / `python -m noetl.worker`

## What is noetl CLI?

`noetl CLI` is a Rust-based command-line tool that serves multiple purposes:

### Primary Functions

1. **Process Management** - Start/stop server and worker with PID tracking
2. **Local Playbook Execution** - Run playbooks locally without server/worker infrastructure
3. **CLI Operations** - Register resources, execute playbooks, query status
4. **Development Tools** - Database initialization, K8s deployment automation
5. **Interactive TUI** - Terminal UI for monitoring and management

### Implementation Details

```rust
// noetl CLI server start spawns:
python -m noetl.server --host 0.0.0.0 --port 8082

// noetl CLI worker start spawns:
python -m noetl.worker
```

**Key Point**: noetl CLI is a **wrapper** that spawns Python processes and manages their lifecycle.

## When to Use Each Approach

### Use noetl CLI (Local Development)

✅ **Recommended for:**
- Local development on Mac/Linux/Windows
- Manual server/worker management
- Local playbook execution without infrastructure ([see Local Execution](./local_execution.md))
- CLI operations (register, execute, list)
- K8s deployment automation (`noetl k8s deploy`)
- Database management (`noetl db init`)

**Advantages:**
- Convenient start/stop without managing PIDs
- Unified CLI for all operations
- PID file tracking at `~/.noetl/noetl_server.pid`
- Built-in health checks and status monitoring

**Example Usage:**
```bash
# Start server locally
./bin/noetl server start --init-db

# Start worker
./bin/noetl worker start

# Run playbook locally (no server/worker needed)
./bin/noetl run automation/tasks.yaml --set target=build -v

# Register playbook (distributed mode)
./bin/noetl register playbook --file playbook.yaml

# Execute playbook (distributed execution via server)
./bin/noetl run catalog/path/to/playbook -r distributed

# Stop server
./bin/noetl server stop
```

### Use Python Direct (Containers & K8s)

✅ **Recommended for:**
- Kubernetes deployments
- Podman containers
- CI/CD pipelines
- Production environments
- Any containerized/orchestrated environment

**Advantages:**
- No wrapper overhead
- Direct process control by orchestrator
- Simpler container images
- Better signal handling (SIGTERM/SIGKILL)
- Works across all architectures without Rust binary

**Example Usage:**

**Kubernetes:**
```yaml
# Server deployment
command: ["python"]
args: ["-m", "noetl.server", "--host", "0.0.0.0", "--port", "8082"]

# Worker deployment
command: ["python"]
args: ["-m", "noetl.worker"]
```

**Podman:**
```dockerfile
CMD ["python", "-m", "noetl.server", "--host", "0.0.0.0", "--port", "8082"]
```

**Direct:**
```bash
# Server
python -m noetl.server --host 0.0.0.0 --port 8082 --init-db

# Worker
python -m noetl.worker
```

## Architecture Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     Local Development                        │
├─────────────────────────────────────────────────────────────┤
│  noetl CLI (Rust)                                            │
│      ↓                                                       │
│  Spawns & Manages                                           │
│      ↓                                                       │
│  python -m noetl.server  ←── Contains uvicorn               │
│  python -m noetl.worker  ←── Contains worker loop           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Kubernetes / Podman / Production                │
├─────────────────────────────────────────────────────────────┤
│  K8s/Podman manages process lifecycle                       │
│      ↓                                                       │
│  python -m noetl.server  ←── Direct execution               │
│  python -m noetl.worker  ←── No wrapper                     │
└─────────────────────────────────────────────────────────────┘
```

## Python Entry Points

### Server (`noetl/server/__main__.py`)

```python
def main():
    """Entry point for NoETL server."""
    # Parse arguments
    args = parser.parse_args()
    
    # Optional: Initialize database
    if args.init_db:
        asyncio.run(initialize_db())
    
    # Start uvicorn server
    import uvicorn
    from noetl.server.app import create_app
    
    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port)
```

**Note**: Uvicorn is embedded in the Python server - no external process manager needed.

### Worker (`noetl/worker/__main__.py`)

```python
def main():
    """Entry point for NoETL worker."""
    # V2 worker architecture
    # Polls jobs via API and NATS
    # No database writes
```

## Multi-Architecture Considerations

### Current Approach (Python-Only)

**Status**: ✅ Works on all architectures (amd64, arm64)

- Podman images run Python directly
- No Rust binary compilation in Podman
- QEMU emulation not needed
- Reliable cross-platform operation

### Future: Pre-Compiled Rust Binaries

If you need Rust CLI in containers:

1. **Build separately**: Use `scripts/build_rust_multiarch.sh`
2. **Copy into Podman**: Pre-compiled binaries for each platform
3. **Optional**: Rust binary available but not required

```dockerfile
# Optional: Copy pre-compiled Rust binary
ARG TARGETARCH
COPY repos/cli/target/x86_64-unknown-linux-gnu/release/noetl /usr/local/bin/noetl || true
COPY repos/cli/target/aarch64-unknown-linux-gnu/release/noetl /usr/local/bin/noetl || true
```

**Important**: Do NOT compile Rust inside Podman builds - it causes QEMU emulation issues on ARM Macs.

## Environment Variables

Both execution methods respect the same environment variables:

```bash
# Server configuration
NOETL_HOST=0.0.0.0
NOETL_PORT=8082
NOETL_ENABLE_UI=true

# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=demo_noetl

# NATS
NATS_URL=nats://noetl:noetl@localhost:4222

# Worker
NOETL_SERVER_URL=http://localhost:8082
```

## CLI Operations

### Using noetl CLI

```bash
# Register playbook
./bin/noetl --host localhost --port 8082 register playbook --file playbook.yaml

# Execute playbook
./bin/noetl --host localhost --port 8082 execute playbook my-playbook --json

# Check status
./bin/noetl --host localhost --port 8082 execute status 12345

# List resources
./bin/noetl --host localhost --port 8082 catalog list playbooks
```

### Using REST API Directly

```bash
# Register playbook
curl -X POST http://localhost:8082/api/catalog/register \
  -H "Content-Type: application/json" \
  -d @playbook.yaml

# Execute playbook
curl -X POST http://localhost:8082/api/execute/playbook/my-playbook \
  -H "Content-Type: application/json" \
  -d '{"input": {}}'

# Check status
curl http://localhost:8082/api/execute/12345
```

Both approaches are equivalent - use noetl CLI for convenience, or REST API for automation.

## Summary

| Environment | Recommended | Method | Why |
|------------|------------|--------|-----|
| Local Mac/Linux | noetl CLI | `./bin/noetl server start` | Convenient, PID management |
| Kubernetes | Python direct | `python -m noetl.server` | K8s manages processes |
| Podman | Python direct | `CMD ["python", "-m", "noetl.server"]` | Container lifecycle |
| CI/CD | Python direct | `python -m noetl.server` | Simpler, portable |
| Windows | noetl CLI | `noetl.exe server start` | Native Windows binary |

**Key Principle**: Use noetl CLI for interactive development, Python direct for production/orchestration.
