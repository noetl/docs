# NoETL Podman Usage Guide

This guide provides detailed instructions for using NoETL with Podman.

## Overview

NoETL can be run in Podman containers, which provides several benefits:

- Consistent environment across different platforms
- Easy deployment
- Isolation from the host system
- Simplified dependency management

## Prerequisites

- Podman installed on your system
- Podman Compose (optional, for multi-container setups)

## Quick Start

### Using the Official Podman Image

The simplest way to run NoETL in Podman is to use the official Podman image:

```bash
# Pull the latest NoETL image
podman pull noetl/noetl:latest

# Run the NoETL server
podman run -p 8082:8082 noetl/noetl:latest
```

This will start the NoETL server and expose it on port 8082 of your host machine.

### Building and Running from Source

If you want to build the Podman image from source:

1. Clone the repository:
   ```bash
   git clone https://github.com/noetl/noetl.git
   cd noetl
   ```

2. Build the Podman image:
   ```bash
   podman build -t noetl:local .
   ```

3. Run the NoETL server:
   ```bash
   podman run -p 8082:8082 noetl:local
   ```

## Using Podman Compose

NoETL provides a Podman Compose configuration that sets up a complete environment with PostgreSQL:

1. Start the containers:
   ```bash
   podman compose up
   ```

2. Or build and start the containers:
   ```bash
   podman compose up --build
   ```

3. To run in detached mode:
   ```bash
   podman compose up -d
   ```

4. To stop the containers:
   ```bash
   podman compose down
   ```

## Using the Makefile

NoETL provides a Makefile with convenient commands for Podman operations:

```bash
# Build the Podman containers
make build

# Start the Podman containers
make up

# Stop the Podman containers
make down

# View logs
make logs

# Run tests in Podman
make test
```

## Accessing the NoETL Server

Once the NoETL server is running in Podman, you can access it at:

- Web UI: `http://localhost:8082`
- API: `http://localhost:8082/api`

## Running Playbooks in Podman

### Using the CLI

You can execute NoETL commands inside the Podman container:

```bash
# Execute a playbooks directly
podman exec -it noetl noetl agent -f /path/to/playbooks.yaml

# Register a playbooks in the catalog
podman exec -it noetl noetl playbooks --register /path/to/playbooks.yaml

# Execute a playbooks from the catalog
podman exec -it noetl noetl playbooks --execute --path "workflows/example/playbook"
```

### Using the API

You can also use the NoETL API to execute playbooks:

```bash
# Register a playbooks
curl -X POST "http://localhost:8082/catalog/register" \
  -H "Content-Type: application/json" \
  -d '{
    "content_base64": "'"$(base64 -i ./path/to/playbooks.yaml)"'"
  }'

# Execute a playbooks
curl -X POST "http://localhost:8082/playbook/execute" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "workflows/example/playbooks",
    "version": "1.0.0",
    "input_payload": {
      "param1": "value1",
      "param2": "value2"
    }
  }'
```

## Mounting Volumes

You can mount volumes to persist data and share files with the Podman container:

```bash
podman run -p 8082:8082 \
  -v $(pwd)/playbooks:/app/playbooks \
  -v $(pwd)/data:/app/data \
  noetl/noetl:latest
```

This mounts the local `playbooks` and `data` directories to the corresponding directories in the Podman container.

## Environment Variables

You can pass environment variables to the Podman container:

```bash
podman run -p 8082:8082 \
  -e POSTGRES_HOST=postgres \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_USER=noetl \
  -e POSTGRES_PASSWORD=noetl \
  -e POSTGRES_DB=noetl \
  noetl/noetl:latest
```

## Podman Compose Configuration

The default `podman compose.yaml` file includes the following services:

- `noetl`: The NoETL server
- `postgres`: PostgreSQL database for storing playbook data

You can customize the Podman Compose configuration by editing the `podman compose.yaml` file.

## Customizing the Podman Image

If you need to customize the Podman image, you can create your own Dockerfile based on the official NoETL image:

```dockerfile
FROM noetl/noetl:latest

# Install additional dependencies
RUN pip install some-package

# Add custom files
COPY ./custom_playbooks /app/playbooks

# Set environment variables
ENV SOME_VARIABLE=some_value

# Set the working directory
WORKDIR /app

# Set the entrypoint
ENTRYPOINT ["noetl", "server"]
```

## Troubleshooting

### Container Fails to Start

If the container fails to start, check the logs:

```bash
podman logs noetl
```

### Cannot Connect to the Server

If you cannot connect to the NoETL server, check that the port is correctly mapped:

```bash
podman ps
```

Make sure the container is running and the port mapping is correct (e.g., `0.0.0.0:8082->8082/tcp`).

### Database Connection Issues

If NoETL cannot connect to the PostgreSQL database, check the environment variables and network configuration:

```bash
# Check the network
podman network ls
podman network inspect noetl_default

# Check the PostgreSQL container
podman logs postgres
```

## Next Steps

- [Installation Guide](/docs/getting-started/installation) - Learn about other installation methods
- [CLI Usage Guide](/docs/cli/usage) - Learn how to use the NoETL command-line interface
- [API Usage Guide](/docs/reference/api_usage) - Learn how to use the NoETL REST API
- [Playbook Structure](/docs/reference/dsl/playbook_structure) - Learn how to structure NoETL playbooks