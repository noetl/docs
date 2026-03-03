---
sidebar_position: 10
title: Multi-Repo Release Process
description: End-to-end release process for NoETL split repositories, including CLI artifacts, Homebrew tap, and APT repository.
---

# Multi-Repo Release Process

This guide is for the split repository layout (`cli`, `server`, `worker`, `gateway`, `tools`, `ops`, `docs`, `homebrew-tap`, `apt`).

## 1) Repository ownership

- `noetl/cli`
  - crate: `noetl`
  - binaries: `noetl`, `ntl`
  - owns Homebrew formula content and APT package content
- `noetl/server`
  - crate: `noetl-server`
  - container image release
- `noetl/worker`
  - crate: `noetl-worker`
  - container image release
- `noetl/gateway`
  - crate: `noetl-gateway`
  - container image release
- `noetl/tools`
  - crate: `noetl-tools`
- `noetl/ops`
  - deployment/release playbooks and operational scripts
- `noetl/homebrew-tap`
  - Homebrew formula repository
- `noetl/apt`
  - Debian/Ubuntu package repository

## 2) Local workspace layout

Expected layout with `ops` submodules:

```bash
/path/to/noetl/ops/
  vendor/cli
  vendor/homebrew-tap
  vendor/apt
  automation/
  scripts/
```

Initialize submodules before running release automation:

```bash
cd /path/to/noetl/ops
git submodule sync --recursive
git submodule update --init --recursive
```

## 3) Versioning rules

- Release tag/version must match `Cargo.toml` in `cli`.
- Use semantic commits (`feat:`, `fix:`) on main branches to trigger semantic-release workflows.
- CLI release artifacts must include:
  - `noetl-v<version>-darwin-arm64.tar.gz`
  - `noetl-v<version>-darwin-x86_64.tar.gz`
  - `noetl-v<version>-linux-arm64.tar.gz`
  - `noetl-v<version>-linux-x86_64.tar.gz`
  - `noetl_<version>-1_arm64.deb`
  - `noetl_<version>-1_amd64.deb`

## 4) Required GitHub secrets

Organization/repository secrets used by workflows:

- `CRATES_IO_TOKEN`
- `HOMEBREW_TAP_PUSH_TOKEN`
- `APT_REPO_PUSH_TOKEN`
- `SEMANTIC_RELEASE_APP_ID`
- `SEMANTIC_RELEASE_PRIVATE_KEY`

## 5) Run release publication from `ops`

The release publication playbook builds/fetches artifacts, updates Homebrew, updates APT metadata, and preserves previously published `.deb` versions.

```bash
cd /path/to/noetl/ops

noetl run automation/release/publish_distribution_repos.yaml --runtime local \
  --set action=publish \
  --set version=2.8.7 \
  --set cli_repo_dir=./vendor/cli \
  --set homebrew_repo=./vendor/homebrew-tap \
  --set apt_repo=./vendor/apt \
  --set artifacts_dir=./build/release \
  --set apt_arches=amd64,arm64 \
  --set macos_arches=arm64,x86_64 \
  --set codenames='jammy noble' \
  --set build_artifacts=true \
  --set prefer_release_assets=true \
  --set push_changes=false
```

`prefer_release_assets=true` behavior:

- Downloads already-published assets from `noetl/cli` release when available.
- Builds only missing artifacts locally (for example Linux arm64 when not present in release assets).

After local validation, publish commits:

```bash
cd /path/to/noetl/ops/vendor/homebrew-tap && git push origin main
cd /path/to/noetl/ops/vendor/apt && git push origin main
```

## 6) What the playbook updates

### Homebrew (`homebrew-tap`)

- Updates `Formula/noetl.rb` to point to `https://github.com/noetl/cli/archive/refs/tags/v<version>.tar.gz`.
- Recomputes SHA256 from the CLI tag tarball.
- Installs both binaries (`noetl`, `ntl`) via Cargo.

### APT (`apt`)

- Appends new `.deb` packages into `pool/main/` (does not delete previous versions).
- Regenerates `Packages`, `Packages.gz`, and `Release` for configured codenames.
- Publishes both `amd64` and `arm64` indexes when packages exist for each architecture.

## 7) Verification checklist

### Artifacts

```bash
ls -la /path/to/noetl/ops/build/release/v2.8.7
```

Expected files include Darwin/Linux tarballs plus `amd64` and `arm64` `.deb`.

### Homebrew formula

```bash
ruby -c /path/to/noetl/ops/vendor/homebrew-tap/Formula/noetl.rb
```

### APT metadata

```bash
grep -E '^(Package|Version|Architecture):' /path/to/noetl/ops/vendor/apt/dists/jammy/main/binary-amd64/Packages
grep -E '^(Package|Version|Architecture):' /path/to/noetl/ops/vendor/apt/dists/jammy/main/binary-arm64/Packages
```

### Installation checks

Homebrew:

```bash
brew tap noetl/tap
brew install noetl
noetl --version
ntl --version
```

APT:

```bash
echo 'deb [trusted=yes] https://noetl.github.io/apt jammy main' | sudo tee /etc/apt/sources.list.d/noetl.list
sudo apt-get update
sudo apt-get install noetl
noetl --version
ntl --version
```

## 8) Component release flow outside CLI

- `server`, `worker`, `gateway`, `tools` publish crates from their own repositories.
- `server`, `worker`, `gateway` also publish container images from their own workflows.
- Keep component versions aligned with CLI when publishing coordinated platform releases.

## 9) Troubleshooting

- `404` downloading release asset:
  - asset not published for that architecture; run with `build_artifacts=true` so ops builds the missing artifact.
- slow Linux cross-arch build:
  - `amd64` on arm hosts can be emulated and slower; keep `prefer_release_assets=true` to skip unnecessary local rebuilds.
- Homebrew formula points to old monorepo:
  - ensure formula URL uses `noetl/cli` tag tarball, not `noetl/noetl`.
