---
title: Local Podman Kind Cluster
sidebar_label: Local Podman Kind Cluster
sidebar_position: 8
---

# Local Podman Kind Cluster

NoETL local development uses a Podman-backed kind cluster. Do not use
Docker Desktop or Colima for the canonical local path. Keeping one
container runtime removes a whole class of "wrong node runtime" and
volume-mount drift when testing playbooks, worker images, GUI images,
and Ollama-backed diagnostics.

## Why Podman, not Docker or Colima

The NoETL local automation assumes:

- kind nodes run on the Podman machine;
- local source paths under `/Volumes` can be mounted into the kind node;
- the same runtime is used when loading or pulling images for local
  validation;
- operator commands can be repeated without switching Docker contexts.

Colima is intentionally out of scope for this workflow. If it appears in
a local note or terminal history, treat it as stale. Use Podman only for
the `kind-noetl` cluster.

## Required `/Volumes` mount

On macOS, the shared checkout lives under `/Volumes/X10/...`. The
Podman machine must expose `/Volumes:/Volumes`; otherwise kind
`extraMounts` and local automation paths cannot resolve files inside
the node.

When creating or recreating the machine, make sure the shared mount is
present before creating the kind cluster. A missing mount is usually
visible as Kubernetes pods failing to find manifests, generated files,
or local playbook paths that exist on the host.

## `XDG_DATA_HOME` hygiene

Run Podman and kind commands with `XDG_DATA_HOME` unset unless the
machine was explicitly created with that variable set:

```bash
unset XDG_DATA_HOME
podman machine list
kind get clusters
```

Podman stores machine metadata under the data home. Mixing values can
make the CLI look at a different machine than the one kind is using.

## Sizing

A practical local baseline is:

| Resource | Recommended local baseline |
|---|---:|
| CPU | 4 |
| Memory | 16 GiB |
| Disk | 200 GiB |

This is enough for the default NoETL stack and `gemma3:4b` diagnostics.
It is not enough to run `gemma4:e4b` inference inside the default
Ollama cgroup. The measured `gemma4:e4b` profile is about 9.4 GiB for
the resident model plus another 9.8 GiB for the inference working set,
or roughly 20 GiB total for the pod cgroup. See
[Triage Model Selection](../architecture/triage_model_selection.md) for
the model tradeoff details.

Keep `gemma3:4b` as the local default. Treat `gemma4:e4b` as a
production or large-node opt-in.

## Optional persistence

Some operators use a macOS LaunchAgent to keep the Podman machine
started after reboots. The local convention is a
`com.noetl.podman-machine.plist` style LaunchAgent, but the repository
does not require a specific plist. If you use one, keep it local to the
machine and do not commit user-specific paths or secrets.

## Bootstrap and recovery commands

Inspect the Podman machine:

```bash
unset XDG_DATA_HOME
podman machine list
podman machine inspect
```

Start or stop it:

```bash
unset XDG_DATA_HOME
podman machine start
podman machine stop
```

Create the kind cluster from the ops repo:

```bash
cd /Volumes/X10/projects/noetl/ai-meta/repos/ops
kind create cluster --config=ci/kind/config.yaml
kubectl config use-context kind-noetl
kubectl cluster-info
```

Delete and recreate only when the user has explicitly chosen that path:

```bash
unset XDG_DATA_HOME
kind delete cluster --name noetl
kind create cluster --config=ci/kind/config.yaml
kubectl config use-context kind-noetl
```

After cluster recreation, deploy NoETL through the ops playbooks or the
documented release deployment path. Avoid one-off scripts unless the
automation being repaired is itself unavailable.
