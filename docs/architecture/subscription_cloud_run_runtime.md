---
id: subscription_cloud_run_runtime
title: Out-of-cluster Subscription Runtime (Cloud Run)
sidebar_label: Subscription Runtime on Cloud Run
sidebar_position: 12
---

# Out-of-cluster Subscription Runtime (Cloud Run)

The subscription/listener runtime (RFC Mode B) turns a message source —
Google Pub/Sub, NATS, Kafka — into a stream of NoETL executions. It is the
same `noetl-worker` binary in `WORKER_MODE=subscription`, holding a
`kind: Subscription` open and dispatching one execution per message.

**Phase 5** runs that runtime *outside the cluster* on **Google Cloud Run**,
so an IoT-scale firehose never consumes cluster capacity — the source's
traffic enters the cluster network only once it is already a well-formed
`POST /api/execute`.

This page documents the Cloud Run target. For the in-cluster KEDA-scaled
pool and the gateway push path, see the
[Subscription / Listener RFC](https://github.com/noetl/ai-meta/wiki/Umbrella-Subscription-Listener).
For why a runtime out of the cluster still calls the API instead of the DB,
see [Ephemeral Blueprints](ephemeral_blueprints) and the data-access
boundary it derives.

## The shape

```
Pub/Sub topic ──► Cloud Run service (min=1, noetl-worker WORKER_MODE=subscription)
                    │  pull loop:  poll → header directives → POST /api/execute   (HTTPS)
                    │  outage:     probe → circuit open → spool to GCS → ack
                    │  recovery:   circuit close → drain → replay in order
                    ▼
              NoETL server  (events flow back: POST /api/events)
```

The runtime is an **ingress producer**. It holds **no database connection**:
every message becomes one `POST /api/execute` and every lifecycle / spool /
directive record is a `POST /api/events`, both over HTTPS. The per-message
playbook logic runs on the in-cluster `subscription` worker pool, never on
Cloud Run. This is the data-access boundary applied across the cluster edge:
the out-of-cluster runtime is a client of the control-plane API, nothing more.

## Pull, not push

A Cloud Run **service** at `--min-instances 1 --max-instances 1`
`--no-cpu-throttling` holds the subscription continuously — a pull listener is
a singleton that must keep one instance alive to own the source. CPU stays
allocated between requests so the background poll loop runs.

(Pub/Sub *push* to a Cloud Run URL is the gateway Mode-C path from Phase 3 and
scales to zero on request rate. The pull runtime here is the dedicated-runtime
path; it trades scale-to-zero for an always-held subscription.)

## Health port

Cloud Run injects `$PORT` and probes a TCP connect on it. The worker's
existing metrics server (`/healthz` + `/metrics`) binds it — set
`WORKER_METRICS_BIND=0.0.0.0:$PORT`, or rely on the worker auto-deriving
`0.0.0.0:$PORT` from `PORT` (v5.18+). **No HTTP code is added for Cloud Run** —
the runtime reuses the observability surface it already exposes in-cluster.

## Authentication

| Hop | Mechanism |
|---|---|
| Runtime → Pub/Sub source | The Cloud Run **service account** via Workload Identity (ADC). The SA is granted `roles/pubsub.subscriber` on the one subscription. No source secret in pod env. |
| Runtime → GCS spool bucket | The same SA via Workload Identity (ADC), granted `roles/storage.objectAdmin` on the one bucket. "Already-in-place trust" — no key file, no keychain hop. |
| Runtime → NoETL control plane | Optional service-account **bearer token**: set `NOETL_INTERNAL_API_TOKEN` and the worker sends `Authorization: Bearer <token>` on every `/api/*` call (the same shape the system pool uses). |

The runtime service account is least-privilege: two scoped role bindings (one
subscription, one bucket), no project-wide roles, no exported key.

## Store-and-forward spool on GCS

Under a downstream outage — for an out-of-cluster runtime, "downstream" is
typically the control plane itself, unreachable over HTTPS — the runtime
buffers to a **GCS bucket** via the `gcs` spool backend (`noetl-tools` v3.5+),
the same Phase-4 engine: per-downstream circuit breaker, `buffer_and_ack` /
`hybrid` durability, ordered replay (`global` / `per_key` / `none`),
idempotency (`idempotency_key` → `message_id`), dead-letter, and a
retention/byte ceiling.

- One bucket serves many subscriptions via object-name prefix, with a
  live/dlq split (`<sub>/spool/` + `<sub>/dlq/`).
- Items are keyed by zero-padded `recv_seq`, so a prefix-scoped list returns
  them in receive order — the cheap path for `ordering: global`.
- `put` overwrites by name (idempotent on the key); `delete` treats 404 as
  success (idempotent GC after drain).
- Circuit state is **in-memory** on Cloud Run (there is no in-cluster NATS KV
  to reach). A restart mid-outage re-probes from `closed` and re-opens on the
  next failure — correct, just without a persisted breaker phase. The GCS
  bucket itself is the durable buffer; persisting circuit phase to a server KV
  endpoint is a hardening follow-up.

## Reachability

Cloud Run reaches the NoETL server over HTTPS. In production that is a public
NoETL server (GKE Ingress / Cloud Run / load balancer with TLS). For proving
the out-of-cluster path against a dev/kind server without exposing it, a
secure tunnel (`cloudflared tunnel --url http://localhost:8082`) gives an
ephemeral `https://…` URL to use as `NOETL_SERVER_URL`.

## Deploy

The build + deploy + teardown recipe lives in
[`noetl/ops` `automation/cloud-run/`](https://github.com/noetl/ops/tree/main/automation/cloud-run)
— `setup-gcp.sh` (least-privilege SA + spool bucket + Pub/Sub source),
`deploy.sh` (Cloud Build image + `gcloud run deploy`), `teardown.sh`, and a
declarative `service.yaml`.

## Cost

A pull runtime bills for one always-allocated instance (256Mi / 1 vCPU) while
deployed; deleting the service stops it (scale-to-zero is not available for a
pull listener). The spool bucket and Pub/Sub topic cost ~nothing when empty;
the bucket carries a short lifecycle TTL as the orphan backstop.
