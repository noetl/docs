---
sidebar_position: 2
---

# Crates.io Releases

The NoETL CLI crate is published from the dedicated Rust repository:

```text
https://github.com/noetl/cli
```

The crate name and installed binary are both `noetl`.

## Release Checklist

1. Update `Cargo.toml` in `noetl/cli`.
2. Run tests and build both binaries:

   ```bash
   cargo test
   cargo build --release --bins
   ls -l target/release/noetl target/release/ntl
   ```

3. Dry-run the package:

   ```bash
   cargo package --list
   cargo publish --dry-run
   ```

4. Tag the CLI repository:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Publish:

   ```bash
   cargo publish
   ```

6. Verify install:

   ```bash
   cargo install --bins noetl --force
   noetl --version
   ntl --version
   ```

## Package Metadata

- Crate: https://crates.io/crates/noetl
- Source: https://github.com/noetl/cli
- Binaries: `noetl`, `ntl`

Do not publish or document Python packaging as a CLI channel. The maintained
CLI implementation is the Rust binary in `noetl/cli`.
