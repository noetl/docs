---
sidebar_position: 1
---

# Distribution Overview

NoETL CLI distribution is owned by the Rust CLI repository:

```text
https://github.com/noetl/cli
```

The maintained command is the native Rust binary named `noetl`. Older Python
package installation paths for the CLI are retired and should not be used in
new documentation, automation, or onboarding instructions.

## Official Channels

| Channel | Repository | Package | Install |
|---|---|---|---|
| Homebrew | `noetl/homebrew-tap` | `noetl` | `brew tap noetl/tap && brew install noetl` |
| APT | `noetl/apt` | `noetl` | `sudo apt-get install noetl` after adding the NoETL APT source |
| Crates.io | `noetl/cli` | `noetl` | `cargo install --bins noetl` |
| GitHub releases | `noetl/cli` | release tarballs | Download `noetl-vX.Y.Z-<os>-<arch>.tar.gz` |

Homebrew and APT are the preferred end-user channels because they install the
released binary without requiring a Rust toolchain. Cargo and GitHub release
tarballs are useful for development, CI, or platforms where a native package is
not available.

## Repository Responsibilities

- `noetl/cli`: Rust source, crate publishing, release tarballs, and release
  coordination.
- `noetl/homebrew-tap`: Homebrew formula for the `noetl` binary.
- `noetl/apt`: Debian/Ubuntu package repository for the `noetl` package.
- `noetl/noetl`: Python server/runtime library and container build inputs, not
  the CLI distribution owner.

## Install Commands

### macOS Or Linux With Homebrew

```bash
brew tap noetl/tap
brew install noetl
noetl --version
```

### Ubuntu Or Debian

```bash
echo 'deb [trusted=yes] https://noetl.github.io/apt jammy main' | sudo tee /etc/apt/sources.list.d/noetl.list
sudo apt-get update
sudo apt-get install noetl
noetl --version
```

### Cargo

```bash
cargo install --bins noetl
noetl --version
```

### GitHub Release Tarball

```bash
VERSION=2.13.0
curl -L -o /tmp/noetl.tgz "https://github.com/noetl/cli/releases/download/v${VERSION}/noetl-v${VERSION}-linux-x86_64.tar.gz"
tar -xzf /tmp/noetl.tgz -C /tmp
sudo install -m 0755 /tmp/noetl /usr/local/bin/noetl
sudo install -m 0755 /tmp/ntl /usr/local/bin/ntl
noetl --version
```

## Release Workflow

The CLI release flow starts in `noetl/cli`:

1. Update the Rust crate version.
2. Tag the CLI repo with `vX.Y.Z`.
3. Publish the Rust crate and GitHub release assets.
4. Update `noetl/homebrew-tap`.
5. Update `noetl/apt`.
6. Verify `noetl --version` through each channel.

Python package releases for the NoETL runtime are separate from CLI releases.
Do not document Python packaging as a NoETL CLI distribution channel.
