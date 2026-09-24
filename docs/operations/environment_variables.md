---
sidebar_position: 6
title: Environment Variables
---

# Environment Variables

The runtime env-var reference for NoETL's deployed components.

:::info Where the authoritative list lives
Each deployed binary keeps its **deployment-specification** page on its own
repo wiki, and that page is the source of truth for its environment: every
variable with its default, whether it is required, and *why* it exists. Those
pages are updated in the same change set as the code that reads them.

| component | authoritative env-var reference |
| :-- | :-- |
| NoETL Server | [noetl/server wiki → deployment-specification](https://github.com/noetl/server/wiki/deployment-specification) |
| NoETL Worker | [noetl/worker wiki → deployment-specification](https://github.com/noetl/worker/wiki/deployment-specification) |
| Gateway | [noetl/gateway wiki → deployment-specification](https://github.com/noetl/gateway/wiki/deployment-specification) |

This page covers what is **cross-cutting** — how configuration is supplied and
how to verify it landed — rather than duplicating those catalogues, because a
duplicated list drifts silently and this page is the evidence: it spent months
documenting variables that nothing reads.
:::

## The components

Three deployed binaries, all Rust:

| component | role |
| :-- | :-- |
| **NoETL Server** | control plane — REST API, catalog, credentials, orchestration |
| **NoETL Worker** | stateless executor; also hosts the EHDB command/event bus writer |
| **Gateway** | HTTP edge — session auth, SSE, callbacks |

The Python server and Python worker are retired, and so is the separate
"Rust worker pool" that once ran alongside them.

## How configuration is supplied

| source | scope |
| :-- | :-- |
| `automation/helm/noetl/values.yaml` (`config.server`, `config.worker`) | Helm-deployed NoETL |
| `automation/helm/gateway/values.yaml` (`env`) | Helm-deployed gateway |
| `ci/manifests/noetl/*-prod.yaml` | the applied prod manifests |
| `automation/deployment/noetl-stack.yaml` | local kind stack |
| `automation/gcp_gke/noetl_gke_fresh_stack.yaml` | GKE fresh stack |

All of these live in [noetl/ops](https://github.com/noetl/ops).

:::warning The manifests are not a complete record
The prod deployment manifests omit a large number of variables that the live
Deployments actually carry, so reading a manifest does not tell you what a pod
is running. Verify against the cluster — see
[Verifying what a pod actually has](#verifying-what-a-pod-actually-has) — and
track the reconciliation in
[noetl/ai-meta#267](https://github.com/noetl/ai-meta/issues/267).
:::

## How the binaries read configuration

Worth knowing, because it changes how you search for a variable:

- **Server** — one struct, `AppConfig`, populated by `envy::prefixed("NOETL_")`.
  A field `foo` is set by `NOETL_FOO`. There is usually **no string literal**
  for the variable name anywhere in the source, so grepping for
  `env::var("NOETL_FOO")` finds nothing even when the variable is live.
- **Worker** — reads directly, largely through typed helpers
  (`env_bool`, `env_u32`, `env_addr`, …), so the literal name *is* in the source.
- **Gateway** — reads directly.

## EHDB tiers

The storage tiers are configured uniformly and are **off unless set**:

```
NOETL_EHDB_ENABLED        # umbrella; everything is disabled without it
NOETL_EHDB_MODE
NOETL_EHDB_CLIENT_ROLE
NOETL_EHDB_<TIER>         # EVENTLOG | PROJECTION | KV | OBJECT | VECTOR
                          #   values: off (default) | shadow | primary
```

Per-tier tuning (directories, size caps, mirror source, GC) is documented on the
worker's deployment-specification page.

## Applying and overriding

**Ops playbook (local + GKE):**

```bash
noetl run automation/deployment/noetl-stack.yaml --runtime local --set action=deploy
```

**Helm:**

```bash
helm upgrade --install noetl automation/helm/noetl \
  --namespace noetl \
  --set config.server.SOME_VAR=value \
  --set config.worker.SOME_VAR=value
```

**Direct patch without a redeploy** — note the deployment names carry the
`-rust` suffix, and the server may run as a StatefulSet rather than a
Deployment depending on the rollout:

```bash
kubectl -n noetl get deploy,sts          # confirm the workload names first
kubectl -n noetl set env deploy/noetl-worker-rust SOME_VAR=value
```

A rolling restart is automatic; values are read at process start.

## Verifying what a pod actually has

The only reliable check is the running pod:

```bash
kubectl -n noetl exec deploy/noetl-worker-rust -- printenv | grep '^NOETL_' | sort
```

To see what a workload *declares* (which may differ from any manifest):

```bash
kubectl -n noetl get deploy noetl-worker-rust \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | sort
```

## See also

- [Architecture](/docs/getting-started/architecture)
- [Components](/docs/operations/components)
