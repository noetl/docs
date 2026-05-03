---
sidebar_position: 4
---

# Cargo/Crates.io Installation

Install the NoETL CLI from the official Rust package registry. The maintained
CLI source lives in `https://github.com/noetl/cli` and installs the `noetl`
binary.

## Quick Install

```bash
cargo install --bins noetl
```

This installs `noetl` to `~/.cargo/bin/`. Make sure that directory is in your
`PATH`.

## Prerequisites

If Rust is not installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Verify:

```bash
cargo --version
rustc --version
```

## Installation Options

### Specific Version

```bash
cargo install --bins noetl --version 2.13.0
```

### From Git

```bash
cargo install --git https://github.com/noetl/cli --bins noetl
```

### From Local Source

```bash
git clone https://github.com/noetl/cli.git
cd cli
cargo install --path .
```

## Verify

```bash
noetl --version
noetl --help
```

## Update

```bash
cargo install --bins noetl --force
```

## Uninstall

```bash
cargo uninstall noetl
```

## Package Details

- **Crate name**: `noetl`
- **Binary name**: `noetl`
- **Source**: https://github.com/noetl/cli
- **Registry**: https://crates.io/crates/noetl

Use the Rust channels on this page for CLI installation.

## Alternative Installation Methods

- **Homebrew**: `brew tap noetl/tap && brew install noetl`
- **APT**: `sudo apt-get install noetl` after adding the NoETL APT source
- **GitHub release tarball**: https://github.com/noetl/cli/releases

## Troubleshooting

### Cargo not found

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Binary not in PATH

```bash
which noetl
ls ~/.cargo/bin/noetl
```

## Next Steps

- [Quick Start Guide](../getting-started/quickstart.md)
- [Local Playbook Execution](../cli/local_execution.md)
- [NoETL CLI](../cli/index.md)
