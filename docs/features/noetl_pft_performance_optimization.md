---
sidebar_position: 46
title: PFT Performance Optimization Analysis
description: Analysis and recommendations for achieving 10-facility PFT execution in under 1 hour.
---

# PFT Performance Optimization Analysis

## Current Baseline

**Workload:** 10 facilities × 1000 patients × 5 data types + MDS batching per facility
**Measured rate:** 3 facilities in 75 min = **25 min/facility**
**Target:** 10 facilities in 60 min = **6 min/facility** → **4.2x speedup required**
**Throughput:** ~200 commands/minute sustained (3 workers × ~67 commands/min/worker)

## Bottleneck Analysis

### 1. Sequential Facility Processing (PRIMARY BOTTLENECK)

The outer facility loop is **sequential** — `load_next_facility → [5 data types] → mark_facility_processed → load_next_facility`. Each facility must complete all 5 data types and MDS batching before the next starts.

```
Facility 1: [assess][cond][med][vital][demo][mds] → 25 min
Facility 2: [assess][cond][med][vital][demo][mds] → 25 min
...
Facility 10: [...] → 25 min
Total: 250 min (sequential)
```

**Impact:** This is the #1 bottleneck. With 3 workers, most are idle waiting during single-facility processing.

### 2. Sequential Data Type Processing Within a Facility

Within each facility, the 5 data types run sequentially:
```
load_patients_for_assessments → claim → fetch(parallel 100) → loop.done
load_patients_for_conditions  → claim → fetch(parallel 100) → loop.done
...
```

Each data type waits for the previous to complete before starting. Only `fetch_*` is parallel (max_in_flight=100).

**Impact:** ~2x loss. Data types could overlap if independent.

### 3. Worker Concurrency Limits

| Parameter | Current | Effect |
|---|---|---|
| Worker replicas | 3 | Only 3 pods processing commands |
| `NOETL_WORKER_MAX_INFLIGHT_COMMANDS` | 8 | Each worker handles max 8 concurrent commands |
| `NOETL_WORKER_DB_SEMAPHORE` | 32 | DB concurrency limit per worker |
| `max_in_flight` (playbook) | 100 | Server issues up to 100 concurrent loop commands |

Effective max parallelism: min(3 × 8, 100) = **24 concurrent commands**. The server issues 100 but workers can only handle 24.

### 4. NATS Claim Round-Trip

Each command requires: server publish → NATS → worker subscribe → HTTP GET context → execute → HTTP POST result → server process. The NATS+HTTP round-trip adds ~5-15ms per command, limiting throughput to ~200/s even at full parallelism.

### 5. Server Single-Threaded Event Processing

`handle_event` processes events sequentially per execution. Under 100 concurrent loop commands, the server may become a bottleneck processing `call.done` events and issuing next commands.

## Optimization Recommendations (Ordered by Impact)

### Tier 1: Configuration Changes (no code, 2-3x speedup)

#### A. Increase worker replicas and concurrency

```yaml
# Worker deployment
replicas: 6  # from 3

# Worker env
NOETL_WORKER_MAX_INFLIGHT_COMMANDS: 16  # from 8
```

Impact: 2x workers × 2x concurrency = **4x effective parallelism** (96 concurrent commands vs 24).

#### B. Reduce claim batch size for faster loop cycling

Currently `claim_batch_size: 100` — each batch processes 100 patients. With 1000 patients per facility per data type, that's 10 loop epochs per type. The loop restart between epochs (NATS KV reset, state rebuild, claim) costs ~500ms each.

```yaml
# Playbook workload
claim_batch_size: 200  # from 100 → 5 epochs instead of 10
```

Impact: 50% fewer epoch transitions → ~10% faster per facility.

### Tier 2: Parallel Data Types Within a Facility (code change, 3-5x speedup)

#### C. Fan-out data types within a facility

Currently sequential:
```
assess → conditions → medications → vital_signs → demographics
```

Proposed: parallel fan-out with fan-in barrier:
```
                ┌─ assessments ─┐
                ├─ conditions  ─┤
setup_facility ─┼─ medications ─┼─ validate_facility
                ├─ vital_signs ─┤
                └─ demographics┘
```

Each data type is independent (different table, different API endpoint). They can run in parallel. Fan-in waits for all 5 to complete before proceeding to MDS and validation.

**Implementation:** Use the `distributed_fanout_mode_spec.md` (already specified, Phase 3 of the distributed processing plan):
- `loop_mode: fanout` on the data-type dispatch step
- Server splits into 5 independent shard commands
- Fan-in via `loop.fanin.completed` event when all 5 are done

Impact: 5x faster within a facility (5 types in parallel vs sequential). Combined with Tier 1: **~5 min/facility → 50 min total**.

### Tier 3: Parallel Facilities (code change, 10x speedup)

#### D. Process multiple facilities concurrently

Currently the outer loop is sequential. If facilities can run in parallel (they're independent — different `facility_mapping_id`):

```
                ┌─ Facility 1 ─┐
                ├─ Facility 2 ─┤
start ──────────┼─ Facility 3 ─┼─ validate_all → check_results → end
                ├─ ...         ─┤
                └─ Facility 10─┘
```

With 6 workers × 16 concurrency = 96 parallel commands, processing 3-4 facilities simultaneously is feasible.

**Implementation:** Two options:

**Option D1: Playbook-level fan-out** — change `load_next_facility` to a `loop_mode: fanout` step that dispatches all 10 facilities as independent shards. Each shard runs the full data-type pipeline. Fan-in after all 10 complete.

**Option D2: Sub-playbook per facility** — dispatch 10 `test_pft_facility_worker` sub-playbooks in parallel, each processing one facility. The parent waits for all sub-executions.

Impact with Tier 1+2+3: 10 facilities × 5 types = 50 independent work units. With 96 parallel commands: **~6 min total**.

### Tier 4: Engine Optimizations (code change, incremental)

#### E. Batch event processing

Process multiple `call.done` events in a single `handle_event` call instead of rebuilding state per event. This reduces DB round-trips for state reconstruction.

#### F. NATS transport for events (Phase 4)

Replace HTTP event emission with NATS publish for `command.completed/failed`. Reduces round-trip from ~10ms to ~1ms. Impact: ~10% at current scale, more at higher parallelism.

#### G. Connection pool tuning

```yaml
NOETL_POSTGRES_POOL_MAX_SIZE: 48   # from 32
NOETL_BG_POOL_MAX_SIZE: 6          # from 4
```

#### H. TempStore tier optimization

Use NATS Object Store (not KV) for collections >100KB to avoid KV size limits. Pre-warm the store connection at worker startup.

## Recommended Implementation Order

| Priority | Change | Effort | Speedup | Target time |
|---|---|---|---|---|
| 1 | **Scale workers** (6 pods × 16 concurrency) | Config | 2-3x | ~12 min/facility |
| 2 | **Parallel data types** (fan-out 5 types) | Playbook + small engine | 3-5x | ~5 min/facility |
| 3 | **Parallel facilities** (fan-out 10 facilities) | Playbook restructure | 5-10x | ~6 min total |
| 4 | Batch event processing | Engine code | 1.2x | — |
| 5 | NATS transport | Engine code | 1.1x | — |

**Achieving the 1-hour target:**
- Tier 1 alone: ~12 min/facility × 10 = 120 min (not enough)
- Tier 1 + 2: ~5 min/facility × 10 = 50 min (**target met**)
- Tier 1 + 2 + 3: ~6 min total (**10x under target**)

## Quick Win: Configuration-Only Changes

To test immediately without code changes:

```bash
# Scale workers
kubectl -n noetl scale deploy/noetl-worker --replicas=6

# Increase worker concurrency
kubectl -n noetl set env deploy/noetl-worker \
  NOETL_WORKER_MAX_INFLIGHT_COMMANDS=16

# Increase server pool for higher parallelism
kubectl -n noetl set env deploy/noetl-server \
  NOETL_POSTGRES_POOL_MAX_SIZE=48
```

Expected result: 2-3x speedup → ~10 min/facility → **~100 min for 10 facilities** (close to target with config alone).
