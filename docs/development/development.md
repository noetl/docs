# NoETL Development Guide

This guide provides information about setting up a development environment for NoETL and contributing to the project.

## Prerequisites

- Python 3.11+ (3.12 recommended)
- Git
- Podman (for containerized local Kubernetes workflows)
- kind and kubectl
- noetl CLI

## Setting Up a Development Environment

### Option 1: Playbook-Based Kubernetes Development (Recommended)

Use NoETL automation playbooks for a streamlined Kubernetes development workflow:

**Prerequisites:**
- Podman
- Kind
- kubectl
- NoETL CLI (`noetl` binary)

```bash
# Clone repository
git clone https://github.com/noetl/noetl.git
cd noetl

# Bootstrap complete environment (first time setup)
noetl run automation/setup/bootstrap.yaml

# Or use the shortcut
noetl run boot
```

**Development Cycle:**
```bash
# Make code changes...

# Rebuild and deploy in one command
noetl run automation/development/noetl.yaml --set action=redeploy

# Check status
noetl run automation/development/noetl.yaml --set action=status

# View logs
kubectl logs -f -n noetl -l app=noetl-server
kubectl logs -f -n noetl -l app=noetl-worker
```

**Available Actions:**

| Action | Description |
|--------|-------------|
| `build` | Build NoETL container image |
| `load` | Load image into kind cluster |
| `deploy` | Deploy to Kubernetes |
| `redeploy` | Full cycle: build → load → deploy |
| `status` | Show pod/service status |

For detailed playbook documentation, see [Automation Playbooks](./automation_playbooks.md#noetl-development-deployment).

### Option 2: Local Python Development

#### 1. Clone the Repository

```bash
git clone https://github.com/noetl/noetl.git
cd noetl
```

#### 2. Create a Virtual Environment

#### Manually

```bash
# Create a virtual environment
python -m venv .venv

# Activate the virtual environment
# On Linux/macOS
source .venv/bin/activate
# On Windows
.venv\Scripts\activate

# Install uv package manager
pip install uv

# Install dependencies
uv pip install -e ".[dev]"
```

#### 3. Install Dependencies

```bash
uv pip install -e ".[dev]"
```

## Project Structure

The NoETL project has the following structure:

```
noetl/
├── bin/                  # Scripts for development and deployment
├── catalog/              # Default catalog for playbooks
├── data/                 # Data files for examples and tests
├── docs/                 # Documentation
├── noetl/                # Main package
│   ├── agent/            # Agent for executing playbooks
│   ├── api/              # API for interacting with NoETL
│   ├── catalog/          # Catalog for managing playbooks
│   ├── cli/              # Command-line interface
│   ├── core/             # Core functionality
│   ├── tasks/            # Task implementations
│   ├── utils/            # Utility functions
│   └── workflow/         # Workflow engine
├── playbook/             # Example playbooks
├── tools/                # Developer tools and scripts (build, versioning); PyPI helpers under tools/pypi
├── tests/                # Tests
└── ui/                   # Web UI
```

## Development Workflow

### Playbook-Based Development (Recommended)

The fastest way to iterate during development:

```bash
# After making code changes, rebuild and deploy
noetl run automation/development/noetl.yaml --set action=redeploy

# Check deployment status
noetl run automation/development/noetl.yaml --set action=status

# View logs
kubectl logs -f -n noetl -l app=noetl-server
kubectl logs -f -n noetl -l app=noetl-worker

# Access services
# NoETL API: http://localhost:30082/api/health
```

**What `redeploy` does:**
1. Builds container image with timestamp tag using `docker/noetl/dev/Dockerfile`
2. Loads image into kind cluster using `kind load docker-image`
3. Applies Kubernetes manifests from `ci/manifests/noetl/`
4. Restarts deployments and waits for pods to be ready

### Local Python Development

#### Running Tests

```bash
# Run all tests
pytest

# Run tests with coverage
pytest --cov=noetl

# Run specific tests
pytest tests/test_agent.py
```

#### Running the Server Locally

```bash
# Run the server in development mode
noetl server --reload
```

### Building the Package

```bash
# Build the package
python -m build
```

### Code Style

NoETL follows the PEP 8 style guide. You can check your code style using:

```bash
# Check code style
flake8 noetl tests
```

## Contributing

### Submitting Changes

1. Fork the repository
2. Create a new branch for your changes
3. Make your changes
4. Run tests to ensure your changes don't break existing functionality
5. Submit a pull request

### Pull Request Process

1. Ensure your code follows the project's style guide
2. Update the documentation to reflect any changes
3. Include tests for new functionality
4. Ensure all tests pass
5. Submit a pull request with a clear description of the changes

## Building and Publishing to PyPI

### Building the Package

```bash
# Build the package
python -m build
```

This will create distribution files in the `dist/` directory.

### Testing the Package

You can test the package locally before publishing:

```bash
# Install the package locally
pip install dist/noetl-*.whl

# Test the package
noetl --version
```

### Publishing to PyPI

NoETL provides scripts for publishing to PyPI:

```bash
# Publish to TestPyPI
./tools/pypi/pypi_publish.sh --test <version>

# Publish to PyPI
./tools/pypi/pypi_publish.sh <version>

# Interactive publishing wizard
./tools/pypi/interactive_publish.sh
```

For more detailed instructions, see the [PyPI Publishing Guide](pypi_manual.md).

## Container Build (Optional)

For local image debugging outside playbooks:

```bash
podman build --platform linux/arm64 -t local/noetl:dev -f docker/noetl/dev/Dockerfile .
kind load docker-image local/noetl:dev --name noetl
```

## Debugging

### Using the Debug Mode

You can run NoETL in debug mode to get more detailed logs:

```bash
# Run the agent in debug mode
noetl agent -f playbooks.yaml --debug

# Run the server in debug mode
noetl server --reload --debug
```

### Using a Debugger

You can use a debugger like `pdb` or an IDE debugger to debug NoETL:

```bash
# Using pdb
python -m pdb -c continue noetl/agent.py -f playbooks.yaml
```

## Next Steps

- [Installation Guide](/docs/getting-started/installation) - Learn about other installation methods
- [CLI Usage Guide](/docs/cli/usage) - Learn how to use the NoETL command-line interface
- [API Usage Guide](/docs/reference/api_usage) - Learn how to use the NoETL REST API
- [PyPI Publishing Guide](pypi_manual.md) - Learn how to build and publish the NoETL package to PyPI