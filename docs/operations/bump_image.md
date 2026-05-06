---
title: bump_image Lifecycle
sidebar_label: bump_image Lifecycle
sidebar_position: 7
---

# bump_image Lifecycle

`noetl/lifecycle/bump_image` is the operational playbook used to move a
running NoETL cluster to a specific container image tag. It is the
preferred path for local validation and release smoke tests because it
keeps the update logic in catalog-registered automation instead of
scattering ad hoc `kubectl set image` commands across runbooks.

## What it does

The playbook updates the NoETL runtime deployments in the `noetl`
namespace:

- `noetl-server`
- `noetl-worker`
- `ollama-bridge`

For each selected deployment, the playbook:

1. resolves the target image from the workload;
2. probes external GHCR images before touching the cluster;
3. checks whether the running deployment already uses the image;
4. runs `kubectl set image` when an update is needed;
5. waits with `kubectl rollout status`;
6. reports the per-component result as structured output.

The implementation is POSIX-shell safe. It does not depend on bash-only
features such as associative arrays, which keeps it portable across the
minimal shells used by worker images and local operator environments.

## GHCR availability probe

The GHCR probe added in
[ops#37](https://github.com/noetl/ops/pull/37) protects the release
validation path from a common race: GitHub can publish a release tag
before the corresponding `ghcr.io/noetl/noetl:<tag>` manifest is
available to pull.

Before the rollout loop starts, the playbook sends a `HEAD` request to:

```text
https://ghcr.io/v2/noetl/noetl/manifests/<tag>
```

It retries until the manifest is visible or the attempt budget is
exhausted. On the final failed attempt, the playbook returns a clear
structured error and exits before changing any deployment.

Workload knobs:

| Knob | Default behavior |
|---|---|
| `ghcr_probe_attempts` | Maximum number of manifest probes. |
| `ghcr_probe_sleep_seconds` | Sleep interval between probes. |

The probe runs only for known external registry image names, such as
`ghcr.io/noetl/noetl:v2.35.9`. Local development images and kind/Podman
shortcuts are skipped because there is no remote manifest to check.

## Idempotent unchanged path

If the target deployment already uses the requested image, the playbook
returns an unchanged result for that component instead of forcing a
rollout. This is useful for validation loops:

- rerunning the playbook after a successful deploy should be clean;
- release validation can prove the "already deployed" path without
  restarting pods;
- a partially updated cluster reports exactly which components changed
  and which were already current.

## Failure modes

| Symptom | Meaning | Operator response |
|---|---|---|
| GHCR probe fails | The release image is not available yet or the node cannot reach GHCR. | Wait for the package to publish, verify package visibility, or fix network/DNS. |
| Rollout timeout | Kubernetes accepted the image update but the deployment did not become ready. | Inspect `kubectl -n noetl describe pod` and deployment events. |
| Per-component error | One deployment failed while another succeeded or was unchanged. | Fix the failed component, then rerun the same payload. |
| Local image skipped probe but pull fails | The image name looked local, so no remote check was possible. | Confirm the image exists in the kind node runtime. |

## Worked example

Deploy a released NoETL tag to all default runtime components:

```bash
noetl exec noetl/lifecycle/bump_image \
  --runtime distributed \
  --payload '{
    "namespace": "noetl",
    "image": "ghcr.io/noetl/noetl:v2.35.9"
  }'
```

Expected shape:

```text
noetl-server  changed|unchanged  ghcr.io/noetl/noetl:v2.35.9
noetl-worker  changed|unchanged  ghcr.io/noetl/noetl:v2.35.9
ollama-bridge changed|unchanged  ghcr.io/noetl/noetl:v2.35.9
```

Target one component explicitly when only a single deployment needs to
move:

```bash
noetl exec noetl/lifecycle/bump_image \
  --runtime distributed \
  --payload '{
    "deployment": "noetl-worker",
    "namespace": "noetl",
    "image": "ghcr.io/noetl/noetl:v2.35.9",
    "ghcr_probe_attempts": 12,
    "ghcr_probe_sleep_seconds": 10
  }'
```

Use the same playbook for release validation and local recovery. Reach
for raw `kubectl set image` only when the catalog or worker path itself
is the part being repaired.
