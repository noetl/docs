---
sidebar_position: 50
title: Storage and Streaming Alignment with RisingWave
---

# NoETL Storage and Streaming Alignment with RisingWave

## Summary

NoETL's TempStore and distributed-runtime model are being aligned with
[RisingWave's architecture](https://docs.risingwave.com/get-started/architecture)
to adopt a proven, standards-based mental model for:

- **Storage:** a three-tier hot → warm → cold hierarchy (memory → local disk cache → object storage),
  mirroring RisingWave's [disk cache](https://docs.risingwave.com/get-started/disk-cache).
- **Execution:** a streaming actor + barrier/checkpoint model, with clear
  separation between control plane (metadata, scheduling) and data plane
  (payload, state).
- **DSL primitives:** first-class [Source / Table / Materialized View / Sink](https://docs.risingwave.com/get-started/source-table-mv-sink)
  tool kinds that compose into pipelines, replacing hand-rolled
  loop/reduce/fan-out patterns where applicable.

This is a multi-phase effort. This document is the anchor for the
mapping and the staging plan.

## Why RisingWave

RisingWave solves the same fundamental problem NoETL is growing into:
maintaining incremental state over continuously arriving work items
with strong replay guarantees and low per-iteration overhead. The
PFT (patient-facility-throughput) load test exposes the cost of
re-inventing primitives RisingWave has already formalized:

- In-flight work queue (pft_test_patient_work_queue) ≈ RW **Table** with
  offsets.
- Per-facility aggregation (validate_facility_results / log_facility_validation) ≈ RW **Materialized View**.
- Final sink (pft_test_validation_log) ≈ RW **Sink**.
- Paginated fetch_X steps ≈ RW **Source** with a downstream **Table**.

Adopting RisingWave's vocabulary gives NoETL a well-understood failure /
recovery / scaling story without rebuilding one from scratch.

## Architecture mapping

| RisingWave | NoETL today | NoETL post-alignment |
| --- | --- | --- |
| Meta Node | `noetl-server` (scheduling, catalog) | `noetl-server` + formal barrier/checkpoint coordinator |
| Streaming Node | `noetl-worker` | `noetl-worker` runs per-step actors with local state + disk cache |
| Serving Node | server HTTP API + gateway | unchanged — PG-compat frontend for ad-hoc queries |
| Compactor Node | *absent* | new `noetl-compactor` role (phase 3) managing disk-cache LSM compaction |
| Actor | ad-hoc `command` execution | command execution tagged with actor id + vnode |
| vnode | `NOETL_SHARD_COUNT` (latent) | formalized hash-partitioned state shard |
| Barrier | `command.issued → command.completed` | formal 1-s barrier cadence flowing server → workers → back |
| Control plane | `noetl.event` / `noetl.command` / `noetl.execution` | unchanged |
| Data plane | TempStore (KV / Object / S3 / GCS / DB) | **TempStore restructured into Memory / Disk / Cloud**; NATS Object Store removed |

## Storage tiers after alignment

| Tier | Backend | Size band | Scope | Survives pod restart? |
| --- | --- | --- | --- | --- |
| `MEMORY` | in-process dict | `< 10 KB` | step | No |
| `KV` | NATS JetStream KV | `< 1 MB` | execution | Yes (distributed) |
| **`DISK` (new)** | local NVMe/SSD cache (PVC) | `1 MB – 10 MB` primary; larger with spill | execution / workflow | Yes (warm-start via `recover_mode=Quiet`) |
| `S3` | S3 / S3-compatible object store (S3 endpoint) | any | execution / workflow / forever | Yes (durable) |
| `GCS` | Google Cloud Storage | any | execution / workflow / forever | Yes (durable) |
| `DB` | PostgreSQL | queryable | workflow / forever | Yes |
| `DUCKDB` | local DuckDB | analytics | step / execution | No (step) |
| `EVENTLOG` | inline in event payload | `< 65 KB` | execution | Yes (via event stream) |

The `OBJECT` tier backed by NATS JetStream Object Store is **removed**.
It was experimental, had weak recovery semantics, and overlapped
functionally with DISK + cloud for every size band.

### Router behaviour

```
size < 10 KB          → MEMORY
size < 1 MB           → KV
size >= 1 MB          → DISK
                           ├── in-process: local cache (hot read)
                           └── async spill: cloud tier (durable)
access_pattern=query  → DB
force_tier=<x>        → <x>
```

A `DISK` write is locally cached on the worker and asynchronously
uploaded to the configured cloud tier so durability matches cloud
storage semantics while read latency matches local SSD.

### Disk cache internals (phase 1)

Following RisingWave's split, the DISK tier maintains two caches per
worker, sized independently:

| Pool | Purpose | Default capacity | Config |
| --- | --- | --- | --- |
| meta cache | TempRef metadata, small-payload pointers | ~10 % of total | `NOETL_STORAGE_LOCAL_META_CACHE_CAPACITY_MB` |
| data cache | payload blocks (1 MB–10 MB typical) | ~90 % of total | `NOETL_STORAGE_LOCAL_DATA_CACHE_CAPACITY_MB` |

Each pool has its own:

- **`capacity_mb`** — disk budget.
- **`insert_rate_limit_mb`** — write throttle (RW recommends ~90 % of
  benchmarked sequential write on local SSD, 50–80 % on cloud block
  storage).
- **`recover_mode`** — `None` for cold start, `Quiet` to reload cache
  contents after pod restart (the dominant mode for scaling and warm
  failover).
- **`data_refill_levels`** — which LSM levels pre-load into cache
  (default 0–6).

### Cloud tier selection

One env var picks the durable backend:

```
NOETL_STORAGE_CLOUD_TIER=s3   # default; S3-compatible object store uses this with NOETL_S3_ENDPOINT override
NOETL_STORAGE_CLOUD_TIER=gcs
```

S3-compatible object store is not a separate tier — it is S3 with a custom endpoint. Existing
`NOETL_S3_BUCKET`, `NOETL_S3_REGION`, and (new) `NOETL_S3_ENDPOINT`
variables configure it.

## DSL primitives — Source / Table / MV / Sink (phase 2)

Today every NoETL tool is imperative: fetch, execute, render. Phase 2
adds four declarative tool kinds that map directly onto RisingWave
objects:

### `kind: source`

Pass-through ingress. No checkpoint, no offset tracking. Suitable for
HTTP GET, Postgres SELECT (non-CDC), file read, S3 list. Cannot be
resumed mid-stream.

```yaml
- step: facility_source
  kind: source
  tool:
    kind: postgres
    auth: pg_k8s
    query: |
      SELECT facility_mapping_id FROM pft_test_facilities WHERE active
```

### `kind: table`

Persistent, checkpointable, queryable. Required for CDC ingress
(RisingWave rule: CDC streams must materialize into a Table before
query). Offsets and state are tracked; step can be replayed.

```yaml
- step: facility_work_queue
  kind: table
  storage: disk             # or s3, db
  schema:
    - facility_mapping_id: int
    - data_type: text
    - patient_id: int
    - status: text
  primary_key: [facility_mapping_id, data_type, patient_id]
```

### `kind: mv`

Incremental materialization over one or more upstream Source / Table.
Recomputes only affected rows on update.

```yaml
- step: facility_done_agg
  kind: mv
  upstream: facility_work_queue
  query: |
    SELECT facility_mapping_id,
           COUNT(*) FILTER (WHERE status = 'done') AS done_count
    FROM facility_work_queue
    GROUP BY facility_mapping_id
```

### `kind: sink`

Typed egress with explicit delivery semantics.

```yaml
- step: validation_sink
  kind: sink
  upstream: facility_done_agg
  delivery: at_least_once      # or exactly_once
  tool:
    kind: postgres
    auth: pg_k8s
    table: pft_test_validation_log
```

**Chaining rule** (from RisingWave): a sink's upstream cannot be a raw
source. It must be a table or MV. This ensures proper checkpointing.

### Loops and until-do under this model

RisingWave does not have native recursion — iteration is expressed as a
draining Source + downstream Table + Sink writing back:

```
Source(pending queue)  →  Table(work state)  →  MV(per-group agg)  →  Sink(write + pop)
```

The loop terminates when the source drains. `until X done` = source
empty + downstream barrier aligned.

The PFT facility loop rewritten in phase 2 would look like:

```yaml
- step: facility_source
  kind: source
  tool:
    kind: postgres
    query: "SELECT facility_mapping_id FROM pft_test_facilities WHERE active"

- step: facility_state
  kind: table
  storage: disk
  upstream: facility_source

- step: facility_agg
  kind: mv
  upstream: facility_state
  query: |
    SELECT facility_mapping_id, count_done, count_total
    FROM facility_state
    ...

- step: validation_sink
  kind: sink
  upstream: facility_agg
  delivery: at_least_once
  tool:
    kind: postgres
    table: pft_test_validation_log
```

No imperative `load_next_facility → mark_facility_processed` cycle; the
framework drains the source and runs the MV incrementally per arrival.

## Phasing

### Phase 0 — this milestone (storage shape + reservations)

- Remove `StoreTier.OBJECT` and `NATSObjectBackend` entirely from
  `noetl/core/storage/`.
- Reserve `StoreTier.DISK` in the enum with a placeholder backend that
  raises `NotImplementedError("phase 1")`; router routes `>= 1 MB` →
  `DISK`, which temporarily falls back to the configured cloud tier
  until phase 1 ships.
- Introduce and document env vars:
  - `NOETL_STORAGE_CLOUD_TIER` — **active** (`s3` default, `gcs`
    alternative).
  - `NOETL_S3_ENDPOINT` — active; enables S3-compatible object store.
  - `NOETL_STORAGE_LOCAL_CACHE_DIR` — reserved.
  - `NOETL_STORAGE_LOCAL_META_CACHE_CAPACITY_MB` — reserved.
  - `NOETL_STORAGE_LOCAL_DATA_CACHE_CAPACITY_MB` — reserved.
  - `NOETL_STORAGE_LOCAL_CACHE_INSERT_RATE_MB` — reserved.
  - `NOETL_STORAGE_LOCAL_CACHE_RECOVER_MODE` — reserved (`None` |
    `Quiet`).
- Back-compat: payloads / playbook fields still carrying `store: object`
  warn once per process and auto-map to `DISK` (which falls back to
  cloud in phase 0). One-release shim.
- Update DSL schemas and fixtures; scrub ConfigMaps; refresh all
  reference docs.

### Phase 1 — disk cache backend

- Implement `DiskCacheBackend` with the two-pool split (meta + data),
  per-pool `capacity_mb` + `insert_rate_limit_mb` + `recover_mode`.
- Async spill to cloud; memoize by content hash.
- Warm-start from disk on worker restart (`recover_mode=Quiet`).
- PVC mount recommendations for kind and GKE (see below).
- Validation: rerun `test_pft_flow` and measure cache-hit-rate during
  replay.

#### PVC mount guidance (phase 1)

The disk cache lives under `NOETL_STORAGE_LOCAL_CACHE_DIR`
(default `/opt/noetl/data/disk_cache`). That path is inside the
`NOETL_DATA_DIR` tree, which workers already mount from a shared PVC.
So in practice **no new PVC is required** — the existing worker volume
hosts the cache.

| Environment | Mount strategy | Notes |
| --- | --- | --- |
| **Local kind (Podman)** | `noetl-data-shared` PVC (RWX, 10 Gi) backed by `hostPath` on the Podman VM node | Already wired in `ci/manifests/noetl/pvc-noetl-data.yaml`; no change needed. |
| **GKE dev / preview** | `noetl-data-shared` PVC with `storageClassName: standard-rwx` (Filestore) | Existing Helm defaults. Filestore IOPS are the cap; tune `NOETL_STORAGE_LOCAL_CACHE_INSERT_RATE_MB` accordingly. |
| **GKE prod / high-throughput** | Prefer per-worker PVC with `storageClassName: premium-rwo` (PD-SSD) and use `StatefulSet` for workers so each pod has a private cache | Requires switching the worker workload from `Deployment` to `StatefulSet`; deferred to phase 3. |

Sizing rules of thumb:

- **Data pool capacity** = 2× the median per-execution externalized
  payload size × `worker.replicas`. For `test_pft_flow` with the current
  claim batch of 200, 2 GB/worker is comfortable.
- **Meta pool capacity** = 10 % of the data pool, never less than
  128 MB (covers the TempRef metadata hot path).
- **Insert rate** = ~90 % of benchmarked sequential write on local
  NVMe (local kind), 50–80 % on cloud block storage (GKE PD / Filestore).
  The default 200 MB/s is a safe NVMe value.
- **Total PVC size** ≥ `data + meta + 25 % eviction headroom`, so a 2 GB
  data pool + 256 MB meta pool needs at least ~3 GB PVC. The shared
  10 Gi default leaves plenty of room even if the pool grows during
  bursts.

Env var wiring (see `repos/ops/automation/helm/noetl/values.yaml`
and `repos/noetl/ci/manifests/noetl/configmap-worker.yaml`):

```yaml
NOETL_STORAGE_CLOUD_TIER: "s3"         # or "gcs"
NOETL_S3_ENDPOINT: "http://object-store.object-store.svc.cluster.local:9000"
NOETL_STORAGE_LOCAL_CACHE_DIR: "/opt/noetl/data/disk_cache"
NOETL_STORAGE_LOCAL_DATA_CACHE_CAPACITY_MB: "2048"
NOETL_STORAGE_LOCAL_META_CACHE_CAPACITY_MB: "256"
NOETL_STORAGE_LOCAL_CACHE_INSERT_RATE_MB: "200"
NOETL_STORAGE_LOCAL_CACHE_RECOVER_MODE: "Quiet"
```

### Phase 2 — Source / Table / MV / Sink tool kinds

- DSL schema entries for the four kinds.
- Runtime: Source = existing `kind: http|postgres|file` with
  `checkpoint=none`; Table = Source + state persistence (disk + cloud);
  MV = Table + incremental aggregation expression; Sink = existing
  `kind: postgres|http|s3` with delivery semantics tagged.
- Port one piece of `test_pft_flow` (per-facility aggregation) as the
  validation target.

### Phase 3 — barrier/checkpoint + compactor role

- Formal 1-s barrier cadence; barrier-aligned MV emission.
- `noetl-compactor` deployment consuming disk-cache LSM metrics.
- Actor / vnode formalized on top of `NOETL_SHARD_COUNT`.

## Migration guidance for callers

### Existing ResultRef / TempRef envelopes

An envelope arriving with `store: "object"` is auto-mapped to
`store: "disk"` and a warning is logged:

```
[storage] DEPRECATED: store='object' is removed; rewriting to 'disk'.
Ref: noetl://execution/.../result/.../abc123
```

Playbook YAML containing `store: object` similarly maps to `disk` at
load time.

### Explicit `force_tier` callers

Python callers passing `StoreTier.OBJECT` must switch to
`StoreTier.DISK` or the desired cloud tier. The enum value is removed
in phase 0; imports referencing `StoreTier.OBJECT` fail at import time,
so the migration is discoverable.

### Artifact URIs

`nats_object://<bucket>/<key>` URIs in stored artifacts raise a clear
`StorageDeprecationError` with migration guidance. A one-shot migration
script (phase 1) will copy outstanding `nats_object://` artifacts into
the configured cloud tier and rewrite the references.

## References

- RisingWave disk cache: https://docs.risingwave.com/get-started/disk-cache
- RisingWave architecture: https://docs.risingwave.com/get-started/architecture
- RisingWave Source/Table/MV/Sink: https://docs.risingwave.com/get-started/source-table-mv-sink
- Prior NoETL data plane separation: `docs/features/noetl_data_plane_architecture.md`
- Phase 0 tracking: see inbox entry and sync note referenced in `repos/ai-meta`.
