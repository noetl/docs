# **NoETL Global Cloud** **Hybrid Supercluster Blueprint**

Catalog-driven, serverless-first, sharded AWS/GCP/Azure/datacenter architecture for NoETL business operating system and quantum cloud workloads

*Draft: 2026-05-29 | Owner: NoETL*

| Field | Value |
| :---- | :---- |
| Document purpose | Blueprint for building NoETL as a global, multitenant, regionalized cloud computation platform. |
| Primary audience | NoETL maintainers, platform engineers, data engineers, security architects, and early design partners. |
| Scope | Event log lifecycle, NATS shard model, sharded Postgres projections, object-store archive, global resource location, multitenancy, sharing, scheduling, and development roadmap. |
| Status | Architecture draft for implementation planning. |

# **Table of Contents**

* 1\. Executive Summary  
* 2\. Design Goals and Non-Goals  
* 3\. Target Architecture  
* 4\. Regional Cell and Shard Model  
* 5\. Event Log Lifecycle  
* 6\. Projection and Query Model  
* 7\. Object Store Archive and Result Bundles  
* 8\. NoETL Resource Locator  
* 9\. Resource Catalog and Resource Registry  
* 10\. Multitenancy, Isolation, and Sharing  
* 11\. Cross-Region Computation and Data Locality  
* 12\. Control Plane Services  
* 13\. Runtime Protocols and Data Contracts  
* 14\. Global Runtime Fabric: Cloudflare, NATS Supercluster, KEDA, and Arrow

## **Distributed Runtime Spec Alignment**

The global cloud blueprint is aligned with the NoETL Distributed Runtime \+ Event-Sourced Shared Memory Spec. That spec defines event-sourced system state, worker-side loop batching, Arrow IPC shared-memory data-plane hints, decentralized projection, and cloud-agnostic event, payload, and projection store abstractions. The blueprint extends those runtime contracts into a multi-cloud and hybrid regional-cell operating model.

Important correction to the earlier planning snapshot: the public distributed-runtime spec now records phases 0-6 as complete for the v2 distributed runtime close-out. The architecture should therefore use the phase table as the implementation baseline, not as a future-only plan.

| Runtime spec area | Blueprint interpretation |
| :---- | :---- |
| Event-sourced state | The active log remains authoritative for replay; completed execution bundles move to object storage with manifest, checksum, payload references, and replay validation evidence. |
| Frame-shaped cursor loops | Workers claim frame-sized units of work, preserve stage/frame lifecycle events, and let the planner fan out/reduce work without losing deterministic replay. |
| Transactional outbox | Event writers append canonical events and enqueue distribution envelopes in the same transaction; publishers drain the outbox to the configured fabric. |
| Arrow IPC Tier 1.5 | Frame outputs may use Arrow/Feather bytes for low-serialization movement while durable payload\_ref/locator remains mandatory for replay after cache eviction. |
| Replay ports | ReplayEventReader and ReplayPayloadResolver keep replay independent of Postgres, object-store brand, or message-fabric choice. |
| Topology metadata | Worker locality, region, zone, cluster, node, worker locator, source locality, and placement evaluation become replayable metadata, not scheduler side effects. |

## **Replaceable Event and Queue Fabric**

NATS JetStream and NATS supercluster should remain the reference implementation because they support the low-latency active event fabric, durable consumers, account isolation, and gateway-meshed regional clusters. However, NoETL must treat the fabric as a port, not as a permanent dependency. The queue/event-fabric adapter must be replaceable by Kafka, Redis Streams, or cloud-native services when customer cost, compliance, or existing infrastructure requires it.

| Fabric option | Best use in NoETL | Notes / guardrails |
| :---- | :---- | :---- |
| NATS JetStream / Supercluster | Reference active event fabric, command queue, projector notifications, edge/datacenter federation. | Use as default for NoETL-owned regional cells and low-latency supercluster operation. |
| Apache Kafka / Redpanda | Enterprise event log and high-throughput stream processing where Kafka already exists. | Good for large enterprises; keep EventStore/CommandQueue ports clean to avoid Kafka-specific semantics leaking into workflow logic. |
| Redis Streams | Lightweight local queue, edge cell queue, dev/test, or short-lived burst buffer. | Do not rely on Redis as the long-term audit archive; persist canonical events/payloads elsewhere. |
| Google Pub/Sub | GCP-native command/fanout adapter and serverless trigger source. | Use for delivery and recent replay; keep canonical event archive in Postgres/object storage or another durable event store. |
| AWS SQS/SNS/EventBridge | AWS-native serverless command queue, event routing, and integration bus. | Use SQS for work queues, SNS/EventBridge for routing and integrations; archive completed execution state to S3. |
| Azure Event Hubs / Service Bus / Event Grid | Azure-native streaming, command messaging, and event notification. | Use Event Hubs for stream ingestion, Service Bus for commands, Event Grid for notifications; archive to Azure Blob or ADLS. |
| Cloudflare Queues / Workers / Durable Objects | Global edge ingress buffering, lightweight edge coordination, customer-facing entrypoint logic. | Useful at the edge; not the primary replay authority for scientific/regulated execution history. |

## **Cloud-Run-First Compute Plane**

NoETL should prefer serverless container compute whenever the workload can be expressed as a stateless or bounded-duration container invocation. Kubernetes remains important, but it should not be the only compute substrate. A cost-effective NoETL global cloud should route simple, bursty, and tenant-isolated workloads to Cloud Run-style services, and use Kubernetes/KEDA only when the workload needs long-lived workers, custom networking, GPU/TPU/QPU adjacency, local shared memory, on-prem connectivity, or supercluster-managed stateful services.

| Compute substrate | NoETL use case | When to choose it |
| :---- | :---- | :---- |
| Google Cloud Run services/jobs | HTTP task endpoints, batch jobs, bursty workers, project-scoped isolated compute. | Default on GCP for short-lived CPU tasks and cost-controlled tenant jobs. |
| AWS Lambda / ECS Fargate / AWS Batch / App Runner | Serverless functions, containerized task workers, batch pools, public API workers. | Default on AWS when avoiding persistent EKS cost or when customers already standardize on AWS serverless. |
| Azure Container Apps / Azure Functions / Azure Batch | Serverless containers, event-driven jobs, enterprise Azure workloads. | Default on Azure when jobs can scale to zero and do not require a dedicated AKS cluster. |
| Kubernetes \+ KEDA | Durable worker pools, projectors, NATS/Postgres sidecars, GPU/TPU-adjacent jobs, on-prem cells, regulated environments. | Choose when workers need persistent pull consumers, local cache/shared memory, strict topology, or datacenter deployment. |
| Slurm / Ray / Dask / Spark / HPC scheduler adapters | University lab clusters, HPC, distributed simulations, large fanout/reduce jobs. | Use as external compute providers behind NoETL adapters; return result manifests through the Resource Registry. |
| Quantum provider / QPU adapters | Quantum circuit execution, hybrid classical/quantum loops, lab instrument orchestration. | Use NoETL tasks as orchestration envelopes around provider APIs or on-prem QPU gateways; store inputs/results as immutable resources. |

## **Multi-Store Projection, Analytics, and Payload Options**

A cross-region NoETL business operating system should not require one database to serve every purpose. The control plane should define ports for EventStore, ProjectionStore, PayloadStore, ResourceCatalog, VectorStore, AnalyticsStore, and SearchStore. A tenant or regional cell may use several of these together. The Resource Registry records which resource lives where, which store owns it, which policy applies, and which compute plane can process it.

| Store / engine | Role in NoETL | Cross-region supercomputer usage |
| :---- | :---- | :---- |
| Postgres / Citus / Aurora PostgreSQL / Cloud SQL / AlloyDB / Azure Database for PostgreSQL | Authoritative catalog, active projections, control-plane metadata, tenant grants, replay indexes. | Default relational control store and shard-local projection store. |
| ClickHouse | High-volume analytical projections, telemetry, runtime observability, cost/accounting facts, event analytics. | Global analytics plane for execution metrics, shard health, tenant cost, frame throughput, and large result summaries. |
| Object storage: S3 / GCS / Azure Blob / MinIO / Ceph / SeaweedFS | PayloadStore and cold archive for completed executions, Arrow/Parquet/Iceberg data files, validation bundles. | Primary cross-region data substrate with sharded bucket naming and immutable manifests. |
| Apache Iceberg \+ Polaris / Gravitino | Open table format and catalog layer for tabular scientific and enterprise datasets. | Allows NoETL-generated datasets to be consumed by warehouses, Spark, Trino, Flink, Databricks, and notebooks. |
| BigQuery / Redshift / Synapse / Microsoft Fabric / Snowflake / Databricks SQL | Customer-native warehouse projections and managed analytics backends. | Use as optional projection targets, not as the only runtime catalog. |
| DuckDB | Local/vectorized post-processing, test fixtures, small/medium result packaging, notebook workflows. | Useful inside workers and archive validators; not a global coordination store. |
| Qdrant / pgvector / OpenSearch / Elasticsearch | Embedding, vector, search, semantic index, and document retrieval projections. | Supports AI-native retrieval across execution archives, lab artifacts, models, and documentation. |
| Redis / Memcached / NATS KV/Object | Hot cache, short-lived lookup cache, edge cache, coordination hints. | Cache only; replay and historical correctness must come from durable event/payload stores. |

## **ClickHouse in Cross-Region Supercomputer Mode**

ClickHouse is a strong optional component for the global analytics plane. It should not replace the Resource Registry or canonical replay authority, but it can become the high-throughput query engine for runtime facts and business operating system dashboards.

**Recommended ClickHouse projection domains:**

* execution\_fact: one row per execution lifecycle transition, with tenant, project, region, shard, status, duration, cost, and resource counters.  
* frame\_fact: one row per frame lifecycle or aggregated frame batch, with stage, worker locality, rows processed, payload shape, and retry information.  
* resource\_fact: resource creation, replication, archive, access, grant, and checksum verification events.  
* compute\_fact: CPU/GPU/TPU/QPU allocation, provider, region, queue wait, runtime, and cost metadata.  
* tenant\_cost\_fact: per-tenant chargeback/showback across compute, storage, egress, and managed service usage.  
* supercluster\_health\_fact: regional NATS/Kafka/PubSub lag, KEDA scale activity, Cloudflare routing decisions, and failover events.

For multi-region deployments, ClickHouse may run per-region with replicated/distributed tables or be treated as an asynchronous analytics sink. No task should block on ClickHouse writes. Runtime correctness remains based on events, payload references, registry records, and projection checkpoints.

## **Next-Generation NoETL Business Operating System for Quantum Cloud**

The long-term product shape is a cross-region, multi-tenant business operating system for computation. In this model, NoETL is not only a workflow runner. It becomes the system of record for who requested computation, which resources were used, which data and models were produced, how results can be shared, and how cost, policy, provenance, and replay evidence are attached to every output.

| Capability | Business operating system function |
| :---- | :---- |
| Tenant/project hierarchy | Universities, laboratories, departments, teams, companies, and shared collaborations receive isolated namespaces with explicit grants. |
| Resource market / resource sharing | Datasets, models, execution results, embeddings, tables, and instruments can be published privately or shared across projects under policy. |
| Compute marketplace | CPU, GPU, TPU, QPU, HPC, serverless, Kubernetes, and on-prem pools become addressable compute capabilities with cost and locality metadata. |
| Global resource location | noetl:// and URN-derived subjects resolve logical resources to physical locations, replicas, credentials, and preferred compute regions. |
| Policy and accounting | Every execution has tenant, region, cost, quota, grant, classification, audit, and retention metadata. |
| Scientific/enterprise provenance | Every result can be traced to events, inputs, code version, payload checksums, worker locality, and replay validation bundles. |
| Cross-region supercomputer mode | NoETL coordinates regional cells as one logical computation plane while preserving data residency, tenant isolation, and locality-aware scheduling. |

## **All-Together Deployment Modes**

NoETL should support three composable deployment modes. The same control-plane contracts should apply in all modes; only adapters and placement policies change.

| Mode | Description | Typical stack |
| :---- | :---- | :---- |
| Managed serverless cell | Cost-optimized cloud cell for bursty customers and isolated tenant jobs. | Cloudflare entrypoint, Cloud Run/Fargate/Container Apps, managed Pub/Sub/SQS/Event Hubs, managed Postgres, object storage. |
| Regional Kubernetes cell | Always-on regional runtime for low-latency queues, projectors, GPU/TPU adjacency, and durable workers. | Cloudflare entrypoint, NATS JetStream, KEDA, Kubernetes, Postgres, object storage, optional ClickHouse/Qdrant. |
| Hybrid datacenter cell | University/lab/company cell connected to the global control plane with local data and compute sovereignty. | On-prem Kubernetes or HPC scheduler, NATS/Kafka bridge, S3-compatible object store, local Postgres/ClickHouse, outbound-only secure control link. |
| Cross-region supercomputer mode | Multiple cloud and datacenter cells federated as a logical computation fabric for scientific and AI/quantum workloads. | Resource Registry, topology service, NATS/Kafka/cloud queues, Cloudflare routing, object-store replication, ClickHouse analytics, QPU/GPU/HPC adapters. |

* 15\. Operational Model  
* 16\. Security Model  
* 17\. Development Roadmap  
* 18\. Minimum Viable Implementation  
* 19\. Risks and Mitigations  
* 20\. References

# **1\. Executive Summary**

NoETL should be built as a regionalized, sharded, multitenant computation cloud. The active execution path should keep commands and events close to the workers that execute them. Historical data should move to durable object storage. Queryable state should live in projection stores, primarily sharded Postgres for the control plane and operational views.

| Area | Blueprint decision |
| :---- | :---- |
| Hot active log | NATS JetStream streams per regional cell and shard. These streams keep active execution events available for replay, retry, monitoring, and projection catch-up. |
| Historical log | Immutable event and result archives in S3, GCS, Azure Blob Storage, or an S3-compatible in-house object store. The archive is the long-term reference for processed executions. |
| Projections | Sharded Postgres stores queryable execution state, indexes, tenant metadata, resource metadata, and projection checkpoints. |
| Large data/results | Never inline large payloads in events. Store payloads as objects; events and projections carry content-addressed references. |
| Global sharing | Share computation outputs through governed NoETL Resource Locators, grants, replication policies, and data-local scheduling. |
| Global topology | A lightweight global catalog maps tenant/project/resource/shard identifiers to regional cells, NATS clusters, Postgres shards, object locations, and access policies. |

## **Core architectural decision**

NATS JetStream  \= hot/active event log and command fabric  
Object storage  \= immutable historical execution archive and large result store  
Postgres        \= shard-local projections, indexes, resource catalog, and checkpoints  
Global catalog  \= metadata, routing, identity, policy, and resource-location resolution  
This model lets NoETL scale independently along the dimensions that matter: event throughput, object payload size, regional isolation, tenant isolation, and query workload. It avoids forcing Postgres to be the only event path while also avoiding the mistake of treating a message bus as the only historical system of record.

# **2\. Design Goals and Non-Goals**

## **Design goals**

* Support active executions with durable, replayable, shard-local event streams.  
* Archive completed executions and result manifests to cloud or in-house object storage for long-term reference.  
* Make every event, result, model, dataset, log segment, and projection snapshot addressable through a unified NoETL Resource Locator.  
* Support multitenant isolation for universities, laboratories, companies, teams, projects, and experiments.  
* Allow controlled sharing of computation results between tasks, projects, tenants, and regions.  
* Run across regional datacenters without requiring a single global database in the data path.  
* Allow NATS clusters, object buckets/prefixes, and Postgres shards to scale independently.  
* Preserve auditability, reproducibility, and data lineage for scientific and enterprise workloads.  
* Support Cloudflare entrypoints for global ingress, tenant-aware request routing, and region/cell selection.  
* Support Kubernetes event-driven autoscaling with KEDA based on NATS JetStream consumer lag and backlog.  
* Support Apache Arrow IPC as a Tier 1.5 payload format for frame-shaped data movement between outbox, projector, and worker runtimes.  
* Support cloud-native and hybrid adapters for queues, object stores, event stores, payload stores, and projection stores.

## **Non-goals**

* Do not build a single globally consistent event database for all regions. NoETL should prefer regional cells and explicit replication over a global write bottleneck.  
* Do not store large binary or tabular results directly in NATS or Postgres event rows. Store references and manifests instead.  
* Do not make cross-tenant sharing implicit. Sharing must be grant-based and auditable.  
* Do not assume one cloud provider. The architecture must work with AWS, GCP, Azure, on-premises S3-compatible stores, and hybrid deployments.

# **3\. Target Architecture**

NoETL global cloud is a federation of regional cells. A cell is a deployable unit containing the control-plane services, NATS JetStream cluster, worker pools, Postgres projection shards, and object-store connectivity required to execute and observe workloads in that region.

                 \+---------------------------------------+  
                 |          Global NoETL Catalog          |  
                 | identity | topology | policy | routing |  
                 \+-------------------+-------------------+  
                                     |  
            \+------------------------+------------------------+  
            |                                                 |  
\+-----------v------------+                         \+-----------v------------+  
| Regional Cell: usw2-a  |                         | Regional Cell: euw1-a  |  
|------------------------|                         |------------------------|  
| NATS JetStream shards  |                         | NATS JetStream shards  |  
| Postgres projections   |                         | Postgres projections   |  
| worker pools CPU/GPU   |                         | worker pools CPU/GPU   |  
| object-store adapters  |                         | object-store adapters  |  
\+-----------+------------+                         \+-----------+------------+  
            |                                                  |  
            v                                                  v  
  S3/GCS/Azure/on-prem object stores                 S3/GCS/Azure/on-prem object stores

| Layer | Primary responsibility | Scale unit |
| :---- | :---- | :---- |
| Global catalog | Tenant registry, topology, policy, resource locator resolution, control metadata. | Globally replicated metadata service; not the high-volume data path. |
| Regional control plane | Accept workload submissions, append execution events, schedule tasks, manage projections, expose APIs. | Regional cell. |
| NATS JetStream | Hot event log, command streams, durable consumers, fanout to projections and workers. | NATS cluster \+ stream shard. |
| Postgres | Projections, indexes, checkpoints, tenant-local operational queries, resource metadata cache. | Postgres shard or cluster per region/cell. |
| Object storage | Historical event segments, execution bundles, result payloads, logs, artifacts, model files, checkpoints. | Bucket/account/container \+ prefix shard. |
| Workers | Execute tasks on CPU/GPU/TPU/quantum provider adapters; publish events; read/write resources. | Worker pool by capability and region. |

# **4\. Regional Cell and Shard Model**

The shard model should be explicit. Each tenant/project/workload maps to a regional home cell and one or more shard identifiers. The shard identifier determines the NATS stream, Postgres projection partition, object-store prefix, and archive path.

## **Shard key**

shard\_key \= hash(tenant\_id \+ project\_id \+ optional\_dataset\_or\_execution\_affinity) % shard\_count

recommended starting point:  
  shard\_count\_per\_region \= 256 logical shards  
  physical\_nats\_clusters \= 1..N per region  
  physical\_postgres\_clusters \= 1..N per region  
  object\_prefix\_shards \= s0000..s0255

## **Shard naming convention**

region:        usw2  
cell:          usw2-a  
tenant:        t\_acme\_lab  
project:       p\_genomics\_01  
logical shard: s0042

NATS stream:   NOETL\_EVT\_usw2\_s0042  
NATS commands: NOETL\_CMD\_usw2\_s0042  
Postgres db:   noetl\_usw2\_s0042  
Object prefix: noetl/env=prod/region=usw2/cell=usw2-a/shard=s0042/tenant=t\_acme\_lab/project=p\_genomics\_01/

| Shard component | Naming rule | Purpose |
| :---- | :---- | :---- |
| NATS event stream | NOETL\_EVT\_\<region\>\_\<shard\> | Hot execution event log. |
| NATS command stream | NOETL\_CMD\_\<region\>\_\<shard\> | Task dispatch, retries, delayed scheduling, cancellation. |
| Postgres schema/db | noetl\_\<region\>\_\<shard\> | Projection and checkpoint storage. |
| Object prefix | env/region/cell/shard/tenant/project/date/execution | Archive and result layout. |
| Global resource URI | noetl://\<tenant\>/\<project\>/\<kind\>/\<id\> | Stable logical identifier independent of physical storage backend. |

## **Cell principles**

* A regional cell should be independently deployable, drainable, and replaceable.  
* Workers should connect outbound to the regional NATS/control plane; cross-region worker calls should be avoided unless explicitly scheduled.  
* Cell-to-cell communication should exchange resource references, manifests, and policy decisions, not raw global database writes.  
* Every cell should be able to continue processing local workloads when another region is degraded, subject to local resource availability and policy.

# **5\. Event Log Lifecycle**

NoETL should distinguish active events, projected state, and archived history. Active events live in NATS JetStream; queryable operational state lives in Postgres; completed execution history and large result manifests live in object storage.

## **Hot, warm, cold lifecycle**

| Tier | Storage | Contains | Retention intent |
| :---- | :---- | :---- | :---- |
| Hot | NATS JetStream | Active execution events, command state, recent task lifecycle events, retry/cancellation events. | Hours to weeks, or longer for active workflows; retention controlled by archive checkpoint. |
| Warm | Postgres projections | Current execution state, task states, resource metadata, indexes, checkpoint positions, audit summaries. | Operational lifetime; compacted and queryable. |
| Cold | Object storage | Immutable event segments, execution archive bundles, result files, logs, metrics summaries, lineage manifests. | Long-term historical reference and reproducibility. |

Append path:  
  1\. Control plane publishes event to JetStream and waits for server acknowledgement.  
  2\. Projection consumer updates Postgres projection idempotently.  
  3\. Archive consumer writes events to object-store segments and commits an archive manifest.  
  4\. Retention controller marks stream sequence ranges as archive-safe.  
  5\. Old hot events may be evicted only after archive-safe status and retention policy are satisfied.

## **Stream separation**

| Stream | Policy | Notes |
| :---- | :---- | :---- |
| NOETL\_CMD\_\<region\>\_\<shard\> | Work queue semantics | Commands are requests to do work. They may be retried, delayed, canceled, or dead-lettered. |
| NOETL\_EVT\_\<region\>\_\<shard\> | Append-only event semantics | Events are facts that happened. Do not mutate. Use compensating events. |
| NOETL\_DLQ\_\<region\>\_\<shard\> | Dead-letter inspection | Failed commands/events requiring operator or automated remediation. |
| NOETL\_ARCHIVE\_ACK\_\<region\>\_\<shard\> | Archive control | Archive progress and retention-safety checkpoints. |

## **Event envelope**

{  
  "event\_id": "01J...",                    // globally unique, generated by NoETL  
  "event\_type": "task.completed",  
  "schema\_version": "noetl.event.v1",  
  "tenant\_id": "t\_acme\_lab",  
  "project\_id": "p\_genomics\_01",  
  "execution\_id": "exec\_20260529\_000001",  
  "workflow\_id": "wf\_variant\_calling",  
  "step\_id": "align\_reads",  
  "task\_id": "gpu\_bwa\_mem",  
  "region": "usw2",  
  "cell": "usw2-a",  
  "shard": "s0042",  
  "causation\_id": "cmd\_01J...",  
  "correlation\_id": "run\_01J...",  
  "created\_at": "2026-05-29T22:00:00Z",  
  "payload": {  
    "status": "ok",  
    "result\_ref": "noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_20260529\_000001/align\_reads/main@v1"  
  },  
  "security": {  
    "classification": "tenant-confidential",  
    "policy\_ref": "policy://t\_acme\_lab/p\_genomics\_01/default-result-policy"  
  }  
}

## **Retention rule**

The active stream should not be allowed to evict events simply because a max age or max bytes limit is reached. For NoETL, eviction must be gated by archive status.

A stream sequence range can be evicted only when:  
  archived \== true  
  projection\_checkpoint \>= range\_end\_sequence for required projections  
  retention\_min\_age has passed  
  no active execution still references the range as unrecoverable hot context

# **6\. Projection and Query Model**

Postgres should serve as the primary operational projection store, not the only system of record for every payload. It keeps the control plane fast and queryable while allowing event history and large artifacts to live elsewhere.

| Projection | Description | Primary key |
| :---- | :---- | :---- |
| execution\_projection | Current status and summary for every execution. | tenant\_id, project\_id, execution\_id |
| task\_projection | Current status and attempts for each step/task. | execution\_id, step\_id, task\_id, attempt |
| resource\_index | Searchable index of resources, result refs, manifests, checksums, locations, and policies. | resource\_uri, version |
| projection\_checkpoint | Per-projection stream sequence cursor. | projection\_name, stream\_name, shard |
| processed\_event | Idempotency ledger for projection consumers. | projection\_name, event\_id |
| archive\_manifest\_index | Pointer to object-store archive bundles and segment manifests. | tenant\_id, execution\_id, segment\_id |
| grant\_index | Materialized access grants and sharing policy cache. | resource\_uri, grantee, scope |

create table projection\_checkpoint (  
  projection\_name text not null,  
  region text not null,  
  shard text not null,  
  stream\_name text not null,  
  last\_stream\_seq bigint not null,  
  last\_event\_id text,  
  updated\_at timestamptz not null default now(),  
  primary key (projection\_name, region, shard, stream\_name)  
);

create table resource\_index (  
  resource\_uri text not null,  
  version text not null,  
  tenant\_id text not null,  
  project\_id text,  
  owner\_principal text not null,  
  resource\_kind text not null,  
  content\_type text,  
  checksum\_sha256 text,  
  size\_bytes bigint,  
  region text not null,  
  shard text not null,  
  storage\_class text not null,  
  location\_descriptor jsonb not null,  
  policy\_ref text,  
  created\_at timestamptz not null default now(),  
  primary key (resource\_uri, version)  
);

# **7\. Object Store Archive and Result Bundles**

Object storage is the durable, cost-efficient place for historical execution data and large computational outputs. The object store layer must be pluggable: S3, GCS, Azure Blob Storage, NATS Object Store for small/simple deployments, MinIO, Ceph, or another S3-compatible in-house store.

## **Execution archive bundle**

archive bundle root:  
  noetl/env=prod/region=usw2/cell=usw2-a/shard=s0042/tenant=t\_acme\_lab/project=p\_genomics\_01/date=2026-05-29/execution=exec\_20260529\_000001/

required objects:  
  manifest.json  
  events/segment-000001.jsonl.zst  
  events/segment-000001.sha256  
  results/result-manifest.json  
  logs/control-plane.jsonl.zst  
  logs/worker-events.jsonl.zst  
  metrics/summary.json  
  lineage/lineage.json  
  security/access-snapshot.json  
  signatures/manifest.sig

| Object | Purpose |
| :---- | :---- |
| manifest.json | Top-level archive descriptor: schema version, event ranges, checksums, created\_at, tenant/project/execution identifiers. |
| events/\*.jsonl.zst | Compressed immutable event segments exported from the active JetStream log. |
| results/result-manifest.json | References to output files, database tables, vectors, reports, models, or external artifacts. |
| logs/\*.jsonl.zst | Control-plane and worker logs required for audit and debugging. |
| metrics/summary.json | Runtime metrics, durations, resource usage, cost estimates, and scheduling decisions. |
| lineage/lineage.json | Input/output graph, versions, datasets, tasks, code artifacts, containers, model versions, and environment digest. |
| security/access-snapshot.json | Policy snapshot used when execution ran; useful for audit and reproducibility. |
| signatures/manifest.sig | Optional signature over manifest and checksums. |

## **Object-store layout principles**

* Use path partitioning that supports lifecycle policies and analytics: env, region, cell, shard, tenant, project, date, execution.  
* Keep all objects immutable once archived. Corrections should create a new version or a compensating manifest, not overwrite history.  
* Use checksums for every payload and manifest. Prefer content-addressing for shared results and model artifacts.  
* Store small metadata in Postgres projections; store large payloads in object storage.  
* Support cross-region replication as a policy attached to the resource, not a hard-coded platform behavior.

# **8\. NoETL Resource Locator**

NoETL needs a stable logical URI for every data asset that can be produced, consumed, archived, shared, replicated, or post-processed. The logical URI must be independent of the physical backend. Physical locations are resolved by the resource catalog and policy engine.

## **Logical URI format**

noetl://\<tenant\>/\<project\>/\<kind\>/\<logical\_path\>@\<version\>

examples:  
  noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_20260529\_000001/align\_reads/main@v1  
  noetl://t\_uc\_lab/p\_climate/models/forecast-net/checkpoint@sha256-b7e4...  
  noetl://t\_company\_a/p\_risk/datasets/market-risk/snapshots/2026-05-29@v3  
  noetl://t\_acme\_lab/p\_genomics\_01/events/exec\_20260529\_000001/archive@final

## **Location descriptor**

{  
  "uri": "noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_20260529\_000001/align\_reads/main@v1",  
  "kind": "result",  
  "tenant\_id": "t\_acme\_lab",  
  "project\_id": "p\_genomics\_01",  
  "owner": "principal://tenant/t\_acme\_lab/service/noetl-control-plane",  
  "classification": "tenant-confidential",  
  "region\_affinity": \["usw2"\],  
  "preferred\_region": "usw2",  
  "home\_cell": "usw2-a",  
  "home\_shard": "s0042",  
  "storage\_class": "warm",  
  "content\_type": "application/vnd.apache.parquet",  
  "size\_bytes": 948392122,  
  "checksum": "sha256:...",  
  "locations": \[  
    {  
      "backend": "s3",  
      "region": "us-west-2",  
      "uri": "s3://noetl-prod-usw2-s0042/.../results/align\_reads/main.parquet",  
      "replica\_state": "primary"  
    },  
    {  
      "backend": "gcs",  
      "region": "us-west1",  
      "uri": "gs://noetl-prod-usw1-s0042/.../results/align\_reads/main.parquet",  
      "replica\_state": "async-replica"  
    }  
  \],  
  "policy\_ref": "policy://t\_acme\_lab/p\_genomics\_01/results/default",  
  "kms\_key\_ref": "kms://t\_acme\_lab/usw2/result-key-01",  
  "lineage\_ref": "noetl://t\_acme\_lab/p\_genomics\_01/lineage/exec\_20260529\_000001@final"  
}

## **Resolution contract**

resolve(noetl\_uri, requester, purpose, preferred\_region, required\_capability) \-\> access plan

access plan:  
  \- allowed or denied  
  \- chosen physical location  
  \- short-lived credentials or signed URL  
  \- expected checksum  
  \- replication/caching instruction if local copy is required  
  \- audit event to append

| Resource kind | Typical physical backing |
| :---- | :---- |
| events | JetStream active range or object-store archive segment. |
| result | Object store object, database table, vector collection, or mounted filesystem object. |
| dataset | Object store prefix, table, Iceberg/Delta-style table, or external catalog object. |
| model | Object store artifact plus metadata; optional model registry projection. |
| log | Object-store log segment plus searchable projection. |
| projection\_snapshot | Postgres snapshot export or object-store compacted view. |
| secret\_ref | External secret manager reference; never resolved into plain text by resource catalog APIs. |

# **9\. Resource Catalog and Resource Registry**

NoETL should include a native Resource Registry as a first-class control-plane service. The registry is the runtime source of truth for resolving logical NoETL resources to physical regional locations, while external data catalogs remain optional integrations for human discovery and governance. This distinction is important: NoETL workers need a fast, policy-aware resolver in the execution path; humans need searchable metadata, documentation, lineage, and ownership views.

## **Architectural decision**

NoETL Resource Registry \= runtime source of truth for resources, locations, grants, and lineage  
Sharded Postgres        \= authoritative metadata store for active catalog records  
Object-store manifests  \= immutable cold/historical resource and execution references  
NATS JetStream          \= catalog change events, cache invalidation, and regional propagation  
Iceberg/Polaris/etc.    \= optional table/dataset catalog layer for analytical datasets  
OpenMetadata/DataHub    \= optional human-facing discovery and governance layer  
The registry should not be implemented as object-store listings, NATS messages, or an external data catalog alone. Object stores are durable but slow to query as metadata systems. NATS is excellent for active events and propagation, but it should not be the catalog database. OpenMetadata, DataHub, Polaris, Gravitino, or cloud provider catalogs may be integrated, but NoETL still needs its own runtime registry for deterministic resource resolution and authorization.

## **Registry versus catalog terminology**

| Layer | Primary audience | Purpose | Typical backing system |
| :---- | :---- | :---- | :---- |
| Resource Registry | NoETL runtime, workers, schedulers, control plane | Resolve noetl:// resources, enforce grants, track locations, replicas, checksums, and lineage | Sharded Postgres plus object manifests |
| Data Catalog | Humans, stewards, governance teams | Search, documentation, ownership, quality, glossary, visual lineage, access request workflow | OpenMetadata, DataHub, cloud catalogs |
| Dataset/Table Catalog | Query engines and lakehouse tools | Manage table metadata, snapshots, partitions, schemas, and data-file manifests | Iceberg REST catalog, Polaris, Gravitino, Glue, BigLake, Unity-like catalogs |

## **Logical resource URI**

All resources should have a stable logical URI that is independent from the current bucket, region, cluster, or database shard. The URI identifies the resource; the registry resolves it to one or more physical locations and access methods.

noetl://\<tenant\>/\<project\>/\<namespace\>/\<resource\_type\>/\<name\>@\<version\>

examples:  
noetl://stanford/lab-a/genomics/dataset/sample\_reads@v3  
noetl://ucb/quantum/experiments/result/run\_2026\_05\_29@final  
noetl://acme/risk/models/model/fraud\_detector@2026-05-29  
noetl://default/demo/executions/archive/exec\_01HYABC@completed

## **Resource types**

| Resource type | Description | Example physical storage |
| :---- | :---- | :---- |
| execution\_archive | Archived event log, manifests, checksums, and lineage for a completed execution | s3://, gs://, az://, minio://, ceph:// |
| result | Task or workflow output, usually referenced by manifest rather than embedded in events | Object store object, database rowset, Iceberg table snapshot |
| dataset | Reusable structured or semi-structured data asset | Iceberg table, Parquet folder, Delta-like layout, database table |
| model | ML/AI model artifact, checkpoint, adapter, embedding model, or prompt pack | Object store bundle, model registry pointer |
| index | Search, vector, graph, or embedding index produced by a workload | Qdrant, OpenSearch, pgvector, object-backed index files |
| schema | Schema, contract, EBNF/JSON Schema/OpenAPI/Avro/Protobuf definition | Catalog row plus object-store definition file |
| credential\_ref | Reference to external secret or identity binding, never the raw secret | Vault, cloud secret manager, KMS envelope reference |
| worker\_pool | Regional compute capacity available for CPU/GPU/TPU/quantum-adjacent tasks | Control-plane registration record |

## **Canonical registry records**

The minimum registry implementation requires four durable metadata groups: resource identity, physical locations, access grants, and lineage. These records live in the tenant/project home shard and may be cached regionally, but Postgres remains the authoritative metadata store for active resources.

resource(resource\_id, tenant\_id, project\_id, namespace, resource\_type, logical\_name, version, home\_region, home\_shard, status, metadata)  
resource\_location(location\_id, resource\_id, region, shard\_id, storage\_type, storage\_uri, checksum, size\_bytes, is\_primary, is\_replica, storage\_class)  
resource\_grant(grant\_id, resource\_id, subject\_type, subject\_id, permission, scope, expires\_at, conditions)  
resource\_lineage(lineage\_id, output\_resource\_id, input\_resource\_id, execution\_id, task\_id, relationship\_type)

## **Resolution contract**

Workers, tools, and post-processing jobs should resolve resources through the NoETL registry rather than hard-coding cloud storage paths. The resolver should consider tenant policy, region affinity, data locality, replica health, storage class, and caller permissions before returning a usable location.

GET /v1/resources/resolve?uri=noetl://stanford/lab-a/genomics/dataset/sample\_reads@v3

{  
  "resource\_id": "res\_01HY...",  
  "resource\_uri": "noetl://stanford/lab-a/genomics/dataset/sample\_reads@v3",  
  "status": "active",  
  "home\_region": "us-west-2",  
  "nearest\_location": {  
    "region": "us-west-2",  
    "storage\_type": "s3",  
    "uri": "s3://noetl-usw2-lab-a/datasets/genomics/sample\_reads/v3/"  
  },  
  "access": {  
    "allowed": true,  
    "credential\_mode": "temporary",  
    "expires\_in\_seconds": 3600  
  }  
}

## **Hot, warm, and cold registry behavior**

| State | Event log | Registry / projection state | Object storage |
| :---- | :---- | :---- | :---- |
| Hot / active execution | NATS JetStream stream is retained for replay and recovery | Full active resource records, grants, locations, and execution indexes in Postgres | Large payloads and intermediate results stored by reference |
| Warm / recently completed | JetStream retained for configured recovery window | Catalog keeps searchable active metadata and archive pointer | Execution bundle, result manifests, and checksums written to object store |
| Cold / historical | JetStream can be compacted or expired after archive verification | Catalog keeps lightweight pointer, ownership, lineage summary, and retention metadata | Immutable archive bundle is the historical source of reference |

## **Catalog-change events**

Every registry mutation should emit a catalog event to NATS JetStream. Regional caches, search indexes, governance exporters, and replication controllers subscribe to these events. This keeps the authoritative state in Postgres while preserving a distributed event-driven propagation model.

noetl.catalog.resource.registered  
noetl.catalog.resource.location\_added  
noetl.catalog.resource.grant\_created  
noetl.catalog.resource.replica\_available  
noetl.catalog.resource.archived  
noetl.catalog.resource.deleted\_or\_expired

## **Integration points**

| Integration | Use when | NoETL role |
| :---- | :---- | :---- |
| Apache Iceberg | Structured analytical datasets need snapshots, schema evolution, partition manifests, and query-engine interoperability | Store dataset resources as Iceberg references and track lineage/grants in NoETL |
| Apache Polaris / Iceberg REST catalog | A neutral catalog service is needed for Iceberg tables across clouds and engines | Use as table catalog; NoETL remains runtime resource registry |
| Apache Gravitino or cloud catalogs | Enterprise data platforms already standardize on lakehouse catalogs | Bridge resource records and table locations |
| OpenMetadata / DataHub | Humans need discovery, docs, ownership, glossary, governance workflows, or visual lineage | Export metadata and lineage; do not put runtime resolution on the critical path |
| OPA / OpenFGA-style policy | Cross-tenant sharing requires expressive authorization and relationship-based access | Evaluate grants and sharing policies during resource resolution |

## **Minimum viable implementation**

* Implement Resource Registry API in the NoETL control plane: register, resolve, add location, grant, lineage, archive, replica.  
* Create sharded Postgres tables for resource, resource\_location, resource\_grant, resource\_lineage, and registry checkpoints.  
* Emit catalog-change events to NATS JetStream for cache invalidation and cross-region propagation.  
* Write object-store archive manifests for completed executions and store registry pointers to those manifests.  
* Require all tools and workers to return result manifests with resource\_uri, storage\_uri, checksum, size\_bytes, format, and schema\_ref when applicable.  
* Add a resolver library to noetlctl, workers, and SDKs so playbooks reference noetl:// URIs instead of provider-specific paths.  
* Add optional Iceberg resource type support before adding broader OpenMetadata/DataHub export.

## **Development rule**

NoETL playbooks, workers, and APIs should treat physical storage URIs as resolved implementation details. Public contracts should use noetl:// logical resources wherever possible. This makes regional movement, replication, migration across cloud providers, and historical archive restoration possible without changing playbook logic.

# **10\. Multitenancy, Isolation, and Sharing**

NoETL should model tenancy as a hierarchy. Each layer adds isolation, policy, quotas, and sharing boundaries.

Organization / Tenant  
  Workspace / Department / Lab  
    Project / Study / Product  
      Workflow / Playbook  
        Execution / Run  
          Step / Task / Attempt  
            Resource / Result / Artifact

| Isolation layer | Required controls |
| :---- | :---- |
| Tenant | Dedicated policy namespace, quotas, KMS root, audit boundary, billing boundary, optional physical shard pinning. |
| Workspace/Lab | Delegated admins, resource groups, grant templates, data classifications. |
| Project | Default region, allowed worker capabilities, budget, network policy, sharing policy. |
| Execution | Runtime identity, immutable inputs, event stream partition, result namespace. |
| Resource | Owner, classification, grants, replicas, lifecycle, checksum, lineage, retention. |

## **Sharing model**

Sharing should be explicit, time-bound where possible, and represented as first-class metadata. A task does not read another tenant’s resource because it knows the bucket path; it reads through a NoETL Resource Locator that resolves policy and returns an access plan.

grant:  
  resource\_uri: noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_123/variant\_table@v1  
  grantee: tenant://t\_partner\_university  
  scope: read  
  purpose: postprocessing  
  expires\_at: 2026-12-31T23:59:59Z  
  allowed\_regions: \[usw2, use1\]  
  allow\_replication: true  
  max\_replica\_lifetime: 30d  
  audit\_required: true

* Default policy: private to tenant and project.  
* Project-level sharing: allow another project in the same tenant to consume selected resources.  
* Tenant-to-tenant sharing: require explicit grant, audit, classification check, and optional legal/data-use agreement reference.  
* Public or community datasets: publish a read-only resource descriptor with immutable versions and checksums.  
* Compute sharing: allow a task to run in another region or tenant-owned worker pool without exposing raw data beyond the granted scope.

# **11\. Cross-Region Computation and Data Locality**

NoETL should schedule computation near data unless policy, cost, capability, or latency requires otherwise. Cross-region sharing should be based on resource references and controlled replication, not ad hoc copying.

| Scenario | Preferred behavior |
| :---- | :---- |
| Data and compute available in same region | Run task locally; read/write local resources; publish local events. |
| Data remote, compute local | Resolve resource; decide whether to replicate/cache input locally or run remote based on size, cost, policy, and worker capability. |
| GPU/TPU capability only in another region | Schedule task to capable region; output location follows policy and can replicate summary/result back to home region. |
| Tenant wants shared result reused globally | Promote result to governed shared resource; create replicas according to lifecycle/replication policy. |
| Strict data residency | Scheduler must not move raw data outside allowed regions; compute must run inside residency boundary. |

scheduling decision inputs:  
  \- resource locations and sizes  
  \- data classification and residency constraints  
  \- required compute capability: CPU/GPU/TPU/quantum-provider/secure-enclave/etc.  
  \- estimated transfer time and cost  
  \- current region capacity  
  \- tenant/project budget  
  \- allowed sharing and replication policy  
  \- cache hit probability and reuse value

## **Cross-region result sharing flow**

1. Producer task writes result to object storage in its home region and emits result.created event.  
2. Projection updates resource\_index with the logical URI and primary physical location.  
3. Archive service writes final result manifest and checksum metadata.  
4. Sharing grant is created or inherited from project policy.  
5. Consumer task resolves the NoETL URI from its region.  
6. Policy engine decides whether to read remote, replicate to local cache, or schedule compute near the data.  
7. Every access and replication action emits audit events into the active event log and archive.

# **12\. Control Plane Services**

| Service | Responsibilities |
| :---- | :---- |
| Topology Service | Maps tenants, projects, executions, and resource URIs to regions, cells, shards, streams, databases, and object prefixes. |
| Event Gateway | Validates and appends events to the correct shard-local JetStream stream; returns event position. |
| Command Scheduler | Creates commands, routes to worker-capability streams, handles retries, deadlines, and cancellation. |
| Projection Service | Consumes events, updates Postgres projections, maintains idempotency and checkpoints. |
| Archive Service | Segments event streams, writes archive bundles to object storage, records archive-safe checkpoints. |
| Resource Catalog | Stores and resolves NoETL Resource Locators and location descriptors. |
| Policy Engine | Evaluates identity, grants, tenant isolation, data classification, residency, and sharing rules. |
| Replication Manager | Creates and monitors object replicas or cache copies according to policy. |
| Worker Registry | Tracks worker pools, capabilities, health, regional affinity, and tenant/project admission rules. |
| Audit Service | Records administrative, policy, access, and replication events. |

minimum control-plane API surface:  
  POST /v1/executions  
  GET  /v1/executions/{execution\_id}  
  POST /v1/events:append  
  GET  /v1/events:read  
  POST /v1/resources:resolve  
  POST /v1/resources:grant  
  POST /v1/resources:replicate  
  GET  /v1/topology/{tenant}/{project}  
  GET  /v1/workers/capabilities

# **13\. Runtime Protocols and Data Contracts**

## **Command envelope**

{  
  "command\_id": "cmd\_01J...",  
  "command\_type": "task.run.requested",  
  "tenant\_id": "t\_acme\_lab",  
  "project\_id": "p\_genomics\_01",  
  "execution\_id": "exec\_20260529\_000001",  
  "step\_id": "align\_reads",  
  "task\_id": "gpu\_bwa\_mem",  
  "required\_capability": \["gpu", "container", "object-store-read"\],  
  "inputs": \[  
    "noetl://t\_acme\_lab/p\_genomics\_01/datasets/reads/sample-a@sha256-..."  
  \],  
  "output\_contract": {  
    "uri": "noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_20260529\_000001/align\_reads/main@v1",  
    "content\_type": "application/vnd.apache.parquet",  
    "retention": "project-default"  
  },  
  "deadline\_at": "2026-05-29T23:00:00Z",  
  "retry\_policy": {"max\_attempts": 3, "backoff": "exponential"}  
}

## **Result manifest**

{  
  "schema\_version": "noetl.result-manifest.v1",  
  "resource\_uri": "noetl://t\_acme\_lab/p\_genomics\_01/results/exec\_20260529\_000001/align\_reads/main@v1",  
  "producer": {  
    "execution\_id": "exec\_20260529\_000001",  
    "step\_id": "align\_reads",  
    "task\_id": "gpu\_bwa\_mem",  
    "worker\_id": "worker\_usw2\_gpu\_17"  
  },  
  "artifacts": \[  
    {  
      "name": "aligned\_reads",  
      "content\_type": "application/vnd.apache.parquet",  
      "uri": "s3://noetl-prod-usw2-s0042/.../aligned\_reads.parquet",  
      "checksum": "sha256:...",  
      "size\_bytes": 948392122  
    }  
  \],  
  "lineage": {  
    "inputs": \["noetl://t\_acme\_lab/p\_genomics\_01/datasets/reads/sample-a@sha256-..."\],  
    "code\_ref": "oci://registry/noetl/tasks/gpu-bwa-mem@sha256:...",  
    "environment\_ref": "noetl://platform/environments/cuda-12-4@sha256-..."  
  }  
}

# **14\. Global Runtime Fabric: Cloudflare, NATS Supercluster, KEDA, and Arrow**

NoETL should treat the global runtime fabric as a combination of edge entrypoints, regional NATS superclusters, Kubernetes-based worker pools, and a columnar payload plane. The goal is not to hide locality completely; the goal is to make locality explicit, routable, observable, and policy-controlled while keeping the user-facing API location-transparent.

## **Cloudflare entrypoints and regional routing**

Users, API clients, agents, notebooks, and partner systems should enter NoETL through global Cloudflare entrypoints. Cloudflare should terminate public TLS, apply WAF/rate-limit rules, verify identity where appropriate, and route requests to the best NoETL regional cell. The selected cell is based on tenant home region, data residency policy, resource location, health, and load. For public SaaS entrypoints, use Cloudflare Load Balancing, health checks, geo/proximity/dynamic steering, and Workers for tenant-aware routing. For private enterprise or university datacenter connectivity, use Cloudflare Tunnel, private network load balancing, or equivalent private ingress patterns.

client / notebook / API / agent  
  \-\> Cloudflare entrypoint: api.noetl.cloud, tenant.noetl.cloud, or lab-specific domain  
  \-\> edge policy: TLS, WAF, identity, rate limits, tenant lookup, residency check  
  \-\> regional control-plane gateway: us-west, us-east, eu-west, asia, or private datacenter  
  \-\> regional NATS / Postgres / object-store shard selected by NoETL Resource Registry

| Cloudflare layer | NoETL use | Design rule |
| :---- | :---- | :---- |
| DNS / Load Balancing | Public API entrypoint and pool failover across regional control-plane gateways | Use health-aware routing. Do not route writes to a region that violates tenant home-region policy. |
| Workers | Lightweight edge router for auth bootstrap, tenant lookup, request normalization, and routing hints | Keep business state in NoETL control plane, not in edge code. |
| Smart Placement / Placement Hints | Place edge logic close to distributed or explicit backend regions when useful | Use for API-routing logic only; NoETL registry remains source of truth for data location. |
| Cloudflare Tunnel / private ingress | Expose university, lab, enterprise, or in-house datacenter cells without public origin IPs | Use for hybrid cells and private control-plane gateways. |
| WAF / rate limits / bot controls | Protect shared multitenant control-plane endpoints | Rate-limit by tenant, project, token, and route. |

## **URN-like Resource Names and NoETL Resource Locator**

NoETL should support both a URL-like form and a URN-like form for logical resource identity. The URL-like form is convenient for developers and manifests; the URN-like form is useful for policy engines, identity systems, stream subjects, and cloud-neutral references. Both forms resolve to the same registry record.

URL-like form:  
  noetl://\<tenant\>/\<project\>/\<namespace\>/\<resource\_type\>/\<name\>@\<version\>

URN-like form:  
  urn:noetl:\<tenant\>:\<project\>:\<namespace\>:\<resource\_type\>:\<name\>:\<version\>

Example:  
  noetl://stanford/lab-a/genomics/dataset/sample\_reads@v3  
  urn:noetl:stanford:lab-a:genomics:dataset:sample\_reads:v3  
NATS subjects should not be treated as the authoritative name of a resource. They are routing subjects derived from the resource name, tenant, project, shard, event type, and execution context. The Resource Registry remains authoritative for resolving a logical resource name to physical object locations, stream names, table snapshots, credentials, and grants.

## **NATS supercluster as decentralized message fabric**

A NoETL global cloud should use regional NATS clusters connected through NATS gateways to form a supercluster. Each regional cluster owns local streams, local durable consumers, local queue groups, and local JetStream storage. Gateways provide cross-cluster routing and failover without requiring a single global NATS cluster or a full mesh of all nodes.

Regional cell A: nats-us-west-01, nats-us-west-02, nats-us-west-03  
Regional cell B: nats-eu-west-01, nats-eu-west-02, nats-eu-west-03  
Regional cell C: nats-private-lab-01, nats-private-lab-02, nats-private-lab-03

Gateway fabric:  
  us-west \<-\> eu-west \<-\> private-lab \<-\> asia

Subject patterns:  
  noetl.cmd.\<tenant\>.\<project\>.\<region\>.\<shard\>.\<workload\>  
  noetl.evt.\<tenant\>.\<project\>.\<region\>.\<shard\>.\<execution\_id\>.\<event\_type\>  
  noetl.catalog.\<tenant\>.\<project\>.\<resource\_event\>  
  noetl.ctrl.\<tenant\>.\<project\>.\<region\>.\<worker\_pool\>

| Concern | Recommended pattern |
| :---- | :---- |
| Locality | Workers should consume from local streams and local durable consumers first. Cross-region delivery is a failover or explicit sharing path, not the default hot path. |
| Subject design | Derive subjects from tenant, project, region, shard, and event type. Keep the canonical resource identifier in the event envelope. |
| Failover | If a regional cell is unhealthy, Cloudflare routes control-plane requests elsewhere and NATS gateway routing makes interested consumers reachable in another cell. |
| Sharding | Use shard-local streams and object prefixes. Avoid one global stream for all tenants. |
| Isolation | Use NATS accounts, credentials, and subject permissions aligned with tenant/project boundaries. |

## **KEDA autoscaling on NATS JetStream lag**

Kubernetes worker pools should scale from zero or a small warm baseline based on NATS JetStream consumer lag, stream backlog, and workload-specific constraints. KEDA provides the Kubernetes event-driven scaling bridge. Each worker deployment, StatefulSet, or job queue can be scaled independently by stream, consumer, tenant class, GPU/CPU profile, and priority lane.

Example scaling target:  
  stream:   NOETL\_CMD\_USW2\_SHARD\_007  
  consumer: worker-gpu-a100-durable  
  metric:   consumer lag / pending messages  
  action:   scale worker deployment from 0..N replicas

KEDA ScaledObject sketch:  
apiVersion: keda.sh/v1alpha1  
kind: ScaledObject  
metadata:  
  name: noetl-worker-nats-jetstream  
spec:  
  minReplicaCount: 0  
  maxReplicaCount: 100  
  scaleTargetRef:  
    name: noetl-worker-pool  
  triggers:  
  \- type: nats-jetstream  
    metadata:  
      natsServerMonitoringEndpoint: nats.monitoring.svc.cluster.local:8222  
      account: NOETL\_TENANT\_OR\_POOL  
      stream: NOETL\_CMD\_USW2\_SHARD\_007  
      consumer: worker-pull-consumer  
      lagThreshold: "25"

| Worker class | Scale signal | Example use |
| :---- | :---- | :---- |
| CPU workers | NATS consumer lag, queue depth, CPU saturation | HTTP calls, Python functions, small ETL transforms, API orchestration |
| GPU workers | NATS lag plus GPU availability and tenant quota | ML inference, model scoring, image/video transforms, vectorization |
| TPU / accelerator workers | Backlog plus accelerator pool admission control | Large model training or batch accelerator workloads |
| Quantum-adjacent / external compute adapters | Command backlog plus external scheduler slots | Submitting jobs to specialized backends and polling results |
| Projector workers | Event-stream lag and checkpoint delay | Projection updates, resource registry updates, replay indexes |

## **Apache Arrow IPC Tier 1.5 payload plane**

NoETL should treat Apache Arrow IPC as a Tier 1.5 payload format between JSON control metadata and durable analytical datasets. JSON remains appropriate for command envelopes, event metadata, manifests, and small payloads. Arrow IPC is the preferred format for frame-shaped intermediate results, projector payloads, and efficient interchange between Python, Rust, Java, Go, DuckDB, DataFusion, Spark-adjacent tools, and GPU-oriented data pipelines.

| Payload tier | Format | Use |
| :---- | :---- | :---- |
| Tier 0 | JSON / JSONB | Control envelopes, event metadata, small structured values, manifests, policies |
| Tier 1 | Object references | Large binary payloads, result bundles, archived execution logs, model files |
| Tier 1.5 | Apache Arrow IPC / Feather V2 | Frame-shaped cursor results, columnar intermediate data, projector outbox payloads, fast local interchange |
| Tier 2 | Parquet / Iceberg tables | Durable analytics, lakehouse datasets, long-term tabular storage, query-engine interoperability |

Arrow payload descriptor in a NoETL result manifest:  
{  
  "payload\_type": "arrow\_ipc",  
  "encoding": "feather\_v2",  
  "schema\_fingerprint": "sha256:...",  
  "rows": 1250000,  
  "columns": 42,  
  "location": {  
    "type": "object\_store",  
    "uri": "s3://noetl-usw2-shard-007/tenant=stanford/project=lab-a/execution=exec\_01HY/frame\_00042.arrow"  
  }  
}

Current implementation status (Python side, as of NoETL v2.92.0+):

* `ArrowIpcSharedMemoryCache` ships at `noetl/core/storage/ipc_cache.py` — 256-MiB default budget, LRU-by-lease eviction, per-pod observability via 7 Prometheus counters + `summary["ipc"]` block on the projector.
* `IpcHint` model carries `shm_name`, `schema_digest`, `byte_length`, `row_count`, `producer`, `node_id`, `lease_expires_at` and is embedded in `ResultRef.ipc` alongside the durable ref.
* Producer wiring (cursor worker) and consumer fast-path (`TempStore.get_ipc_bytes`) both ship; the Phase 3 audit-table entry on line 968 records this as done.

Remaining future work for true cross-language zero-copy (still tracked):

* Apache Arrow Flight endpoint on the worker for cross-pod / cross-node IPC retrieval.
* Native Rust consumer of `IpcHint` — a Rust worker that mmaps a Python-produced segment without a serialization round-trip. Covered by Appendix H (Rust Migration Path).
* Broader producer adoption (promoting the `python` and `http` tool kinds to stage IPC) — out-of-spec; tracked separately.

## **Cloud-native and hybrid adapter model**

NoETL should keep the control-plane contracts portable and implement cloud-specific or datacenter-specific behavior behind ports/adapters. This allows a university lab to run a private MinIO/Ceph/NATS/Postgres cell while another tenant runs on S3/GCS/Azure Blob, Pub/Sub/Event Hubs/SQS, and managed Postgres-compatible databases.

| Port | Cloud-native adapters | Hybrid / datacenter adapters |
| :---- | :---- | :---- |
| EventStore | NATS JetStream, Kafka-compatible services, cloud stream services where appropriate | NATS JetStream, Kafka/Redpanda, Postgres append log |
| CommandQueue | NATS JetStream, Pub/Sub, SQS, Event Hubs, Service Bus | NATS JetStream, RabbitMQ, Kafka/Redpanda, Postgres queue |
| PayloadStore | S3, GCS, Azure Blob, cloud HDFS-compatible stores | MinIO, Ceph RGW, on-prem S3-compatible store, NFS-backed object gateway |
| ProjectionStore | Cloud Postgres, AlloyDB, Cloud SQL, Aurora/RDS, BigQuery/ClickHouse for analytical views | Postgres, Citus, Timescale, ClickHouse, DuckDB for local/materialized views |
| CatalogStore | Managed Postgres-compatible shards plus object manifest archive | Self-managed Postgres shards plus object manifest archive |

Adapters should never leak cloud-specific paths into workflow logic. The workflow should refer to logical resources, and the registry/adapter layer should resolve them to physical storage, queue, and compute locations.

## **Failure and takeover flow**

\[Incoming request or command\]  
  \-\> Cloudflare routes to nearest healthy policy-compliant cell  
  \-\> NoETL Resource Registry resolves tenant/project/resource and home shard  
  \-\> Command enters local NATS JetStream stream  
  \-\> KEDA observes consumer lag and scales worker pool  
  \-\> Worker writes events/results and object payload references  
  \-\> Projector updates Postgres projections and catalog records  
  \-\> Archive service moves completed execution bundle to object storage

If a cell fails:  
  \-\> Cloudflare stops sending public requests to unhealthy origin pool  
  \-\> NATS supercluster routes to interested consumers in a surviving region when configured  
  \-\> Resource Registry marks impacted locations degraded and chooses replicas  
  \-\> KEDA in the surviving region scales replacement workers from backlog

# **15\. Operational Model**

| Operational area | Blueprint |
| :---- | :---- |
| Backups | Back up Postgres projection shards; archive object stores through versioning/immutability/lifecycle rules; do not rely on NATS alone for historical retention. |
| Disaster recovery | Rebuild projections from object-store event archive or active stream. Recover active shards from JetStream replicas and archive-safe checkpoints. |
| Observability | Metrics per region/cell/shard: stream lag, projection lag, archive lag, command retries, worker utilization, object replication lag, policy denials. |
| Rebalancing | Use logical shards and topology service. New executions can move to new shards; old executions remain addressable by resource locator. |
| Schema evolution | Version every event, command, manifest, location descriptor, and projection schema. Use compatibility checks before deployment. |
| Tenant onboarding | Allocate tenant metadata, default project, KMS policy, shard assignment, object prefix, quotas, and default sharing policy. |
| Tenant offboarding | Freeze new writes, export archive manifests, revoke grants, retain/delete according to contract, emit audit events. |

## **Required operational metrics**

* JetStream stream bytes, messages, first/last sequence, consumer lag, redelivery count, DLQ rate.  
* Projection lag by shard and projection name.  
* Archive lag by stream sequence range and object prefix.  
* Resource resolution latency, policy-denial count, signed URL/token issuance count.  
* Object-store replication lag, replica health, checksum verification failures.  
* Worker pool capacity by capability, region, tenant, and task type.  
* Per-tenant cost and quota utilization: CPU/GPU time, bytes stored, bytes transferred, active executions, archive volume.

# **16\. Security Model**

* All resources have an owner, tenant, project, classification, policy reference, and audit trail.  
* All physical accesses should be mediated by short-lived credentials, signed URLs, or workload identity, not static keys in playbooks.  
* Use separate KMS keys or key namespaces per tenant, with project-level overrides where required.  
* Store secrets in external secret managers; NoETL events should contain secret references only.  
* Use mTLS or equivalent strong identity between control-plane services, NATS, workers, and storage adapters.  
* Make cross-tenant grants explicit and auditable; policy decisions should generate audit events.  
* Support data-residency policies by region and resource classification.  
* Support legal hold and immutable archive retention for regulated tenants.

| Threat | Mitigation |
| :---- | :---- |
| Tenant reads another tenant’s object path directly | Do not expose raw physical paths unless policy allows; use signed access plans scoped to the resolved resource. |
| Worker exfiltrates data outside allowed region | Worker admission policy, network policy, region constraints, signed URL scope, egress monitoring. |
| Event stream retention deletes unrecovered history | Archive-safe checkpoint gate before hot eviction; periodic recovery drills. |
| Projection corruption | Rebuild from active stream or object-store event archive; idempotent projection consumers. |
| Stale replica used for computation | Location descriptor includes replica state, generation, checksum, and freshness policy. |
| Over-permissive sharing grant | Policy review workflow, expiration, purpose limitation, audit trail, classification constraints. |

# **17\. Development Roadmap**

| Phase | Deliverable | Exit criteria |
| :---- | :---- | :---- |
| Phase 0: Contracts | Define event envelope, command envelope, resource locator, location descriptor, result manifest, archive manifest. | Schemas published; compatibility tests in CI. |
| Phase 1: Single regional cell | NATS JetStream active event/command streams, Postgres projections, object-store result refs. | One local/kind deployment can execute workflows and rebuild projections. |
| Phase 2: Archive service | Event segment exporter, execution archive bundle, archive manifest index, retention-safe checkpoints. | Completed execution can be replayed/rebuilt from object archive. |
| Phase 3: Shard-aware routing | Topology service, logical shard assignment, per-shard streams, per-shard Postgres schemas/databases. | New executions route by tenant/project/shard and can be queried by locator. |
| Phase 4: Resource catalog | NoETL URI resolution, location descriptors, signed access plans, resource\_index projection. | Tasks consume and publish resources by NoETL URI, not raw bucket paths. |
| Phase 5: Multitenancy and grants | Tenant hierarchy, policy engine, grant model, audit events, quotas. | Cross-project and cross-tenant result sharing works under explicit grants. |
| Phase 6: Multi-region federation | Multiple cells, cross-region resolution, replication manager, data-local scheduler. | A task in one region can safely consume or request replication of a resource from another region. |
| Phase 7: Advanced compute marketplace | University/lab/company resource pools, GPU/TPU/quantum adapters, isolated worker admission. | Tenants can publish compute capacity and consume shared resources under policy. |

## **Current implementation status by phase**

The following table records the current development state of the NoETL distributed runtime roadmap and should be used to drive repository issues, milestone planning, and acceptance criteria.

| Phase | Status | Notes |
| :---- | :---- | :---- |
| 0 \- instrumentation \+ stage/frame tables \+ replay API | done | Stage/frame tables, replay API, replay parity gates, validation artifacts, and storage-neutral replay reader/payload resolver contracts are complete. |
| 1 \- frame-shaped cursor loops | done | Frame-shaped cursor loops landed; frame lifecycle, claims, starts, commits, terminal links, and deterministic replay surfaces are now part of the runtime contract. |
| 2 \- projector StatefulSet behind durable consumers | done | Projectors run behind durable consumers with shard ownership, strict startup validation, ACK/NAK/TERM metrics, decode/projection error split, and Phase 2 evidence bundles. |
| 3 \- Apache Arrow IPC Tier 1.5 | done | Arrow/Feather payload bytes are supported through the outbox/projector path; durable payload references remain the replay authority. |
| 4 \- URN \+ KEDA \+ NATS supercluster | done | URN/resource locator, KEDA NATS scaler, multi-cluster NATS topology generator, supercluster runtime fixes, and NATS account fix are complete. |
| 5 \- port/adapter event-store \+ payload-store \+ projection-store | done | Storage-neutral ports are defined; PayloadStore adapters include filesystem, S3, GCS, Azure Blob, and S3-compatible SeaweedFS. |
| 6 \- stage planner for fanout/reduce | done | Fanout/reduce planner landed as the basis for locality-aware computation, reduction, and post-processing. |

## **Roadmap implications**

* Treat phases 0-6 as the distributed-runtime foundation; the next roadmap layer is packaging the runtime as a cloud business operating system with tenant accounting, resource markets, policy, and global placement.  
* Keep NATS JetStream as the reference active fabric, but enforce adapter boundaries so Kafka, Redis Streams, Pub/Sub, SQS/SNS/EventBridge, and Azure messaging services can replace the transport when cost or enterprise integration requires it.  
* Prefer serverless container compute for bursty customer workloads; reserve Kubernetes/KEDA clusters for always-on workers, GPU/TPU/QPU adjacency, stateful projectors, on-prem cells, and datacenter supercluster nodes.  
* Promote ClickHouse and warehouse/lakehouse adapters as optional global analytics/projection planes rather than mandatory runtime dependencies.

# **18\. Minimum Viable Implementation**

The first implementation should be intentionally small but should use the same abstractions that the global cloud will need later.

## **MVI topology**

local/kind or single cloud region:  
  \- one NATS JetStream cluster  
  \- one Postgres instance  
  \- one object-store bucket or MinIO bucket  
  \- one control-plane API  
  \- one worker pool  
  \- one archive service  
  \- one projection service  
  \- one resource catalog table

| MVI component | Implementation detail |
| :---- | :---- |
| Stream names | NOETL\_EVT\_dev\_s0000, NOETL\_CMD\_dev\_s0000, NOETL\_DLQ\_dev\_s0000. |
| Object prefix | noetl/env=dev/region=local/cell=local-a/shard=s0000/tenant=\<tenant\>/project=\<project\>/... |
| Postgres schemas | projection\_checkpoint, processed\_event, execution\_projection, task\_projection, resource\_index, archive\_manifest\_index. |
| NoETL URI | Implement logical URI parser and resolver before adding multi-region routing. |
| Archive | Archive completed executions to manifest \+ events JSONL.zst \+ result manifest. |
| Replay | CLI command: noetl replay \--from-archive \<execution-uri\> \--projection execution\_projection. |

\- one Cloudflare-routed public or private entrypoint  
\- one KEDA operator watching NATS JetStream consumer lag  
\- one regional NATS gateway configuration, even if single-region in MVI  
\- one Arrow IPC payload path for frame-shaped results  
serverless-first extension:  
  \- route stateless task containers to Cloud Run / Fargate / Container Apps when possible  
  \- reserve Kubernetes/KEDA for durable consumers, projectors, and locality-sensitive workers  
  \- keep NATS JetStream as reference fabric, but configure queue\_adapter per region  
  \- allow ClickHouse, BigQuery, Snowflake, Databricks, Redshift, Synapse, or DuckDB as projection sinks  
example noetl.yaml storage section:

storage:  
  event\_store:  
    type: nats\_jetstream  
    stream\_template: "NOETL\_EVT\_{region}\_{shard}"  
    retention:  
      min\_hot\_age: 7d  
      require\_archive\_safe: true  
  command\_queue:  
    type: nats\_jetstream  
    stream\_template: "NOETL\_CMD\_{region}\_{shard}"  
  projection\_store:  
    type: postgres  
    dsn\_ref: "secret://noetl/dev/postgres"  
    schema\_template: "noetl\_{region}\_{shard}"  
  archive\_store:  
    type: s3\_compatible  
    bucket\_template: "noetl-{env}-{region}-{shard}"  
    prefix\_template: "tenant={tenant}/project={project}/date={date}/execution={execution\_id}/"  
  resource\_catalog:  
    type: postgres  
    resolve\_by: noetl\_uri

# **19\. Risks and Mitigations**

| Risk | Why it matters | Mitigation |
| :---- | :---- | :---- |
| NATS treated as forever archive | Stream storage is operationally expensive and retention-limited by configuration. | Use NATS as hot active log; archive immutable history to object storage; gate eviction by archive-safe checkpoints. |
| Object archive not queryable enough | Long-term history can become hard to inspect. | Maintain Postgres archive\_manifest\_index and optionally export event segments to analytics tables. |
| Cross-region sharing becomes uncontrolled copying | Cost, security, and lineage problems. | Use resource locator, grants, replication policies, TTL caches, and audit events. |
| Shard mapping changes break references | Old executions must remain addressable. | Resource locator resolves through topology/catalog history; physical locations are versioned descriptors. |
| Projection lag hides recent state | Users may see stale execution status. | Expose projection lag; allow direct event read for recent execution state when necessary. |
| Tenant isolation conflicts with shared computation | Universities/labs/companies want both isolation and collaboration. | Use explicit grants, shared datasets, clean-room style execution, and policy-aware scheduling. |
| Cloud-specific features leak into core model | NoETL must stay portable. | Keep cloud adapters below Resource Location and Archive Store interfaces. |

# **20\. References**

These references informed the external storage and messaging assumptions. The NoETL-specific architecture decisions in this document are proposed design decisions, not claims from these external documents.

* NATS JetStream overview: https://docs.nats.io/nats-concepts/jetstream  
* NATS JetStream streams: https://docs.nats.io/nats-concepts/jetstream/streams  
* NATS JetStream model deep dive: https://docs.nats.io/using-nats/developer/develop\_jetstream/model\_deep\_dive  
* NATS JetStream Object Store: https://docs.nats.io/nats-concepts/jetstream/obj\_store  
* Google Cloud Pub/Sub subscription properties: https://docs.cloud.google.com/pubsub/docs/subscription-properties  
* Google Cloud Pub/Sub quotas and limits: https://docs.cloud.google.com/pubsub/quotas  
* Amazon S3 Multi-Region Access Points: https://docs.aws.amazon.com/AmazonS3/latest/userguide/MultiRegionAccessPoints.html  
* Azure Blob Storage object replication: https://learn.microsoft.com/en-us/azure/storage/blobs/object-replication-overview

## **Additional references for global runtime fabric**

* KEDA NATS JetStream scaler documentation \- scale Kubernetes workloads based on NATS JetStream stream/consumer lag.  
* NATS Super-cluster with Gateways documentation \- connect regional clusters through gateways and propagate interest across clusters.  
* Cloudflare Load Balancing traffic steering documentation \- route requests to healthy pools and endpoints using global and local steering policies.  
* Cloudflare Workers placement documentation \- Smart Placement and Placement Hints for edge logic close to distributed or explicit backend infrastructure.  
* Apache Arrow Columnar Format and IPC documentation \- language-agnostic columnar memory layout, metadata serialization, and IPC/file transport for frame-shaped data.

## **Additional references for distributed runtime, serverless compute, and analytics options**

* NoETL Distributed Runtime \+ Event-Sourced Shared Memory Spec: https://noetl.dev/docs/features/noetl\_distributed\_runtime\_spec  
* NoETL docs repository source for distributed runtime spec: https://github.com/noetl/docs/blob/main/docs/features/noetl\_distributed\_runtime\_spec.md  
* Google Cloud Run services and jobs: https://cloud.google.com/run/docs  
* AWS serverless containers and batch options: AWS Lambda, ECS Fargate, AWS Batch, and App Runner documentation.  
* Azure serverless containers and batch options: Azure Container Apps, Azure Functions, and Azure Batch documentation.  
* Apache Kafka, Redis Streams, Google Pub/Sub, AWS SQS/SNS/EventBridge, and Azure Event Hubs/Service Bus/Event Grid are adapter targets, not mandatory dependencies.  
* ClickHouse can be used as an optional analytics/projection plane for high-volume runtime facts and tenant accounting.

# **Appendix A: Suggested Repository Work Items**

| Area | Initial GitHub issues / tasks |
| :---- | :---- |
| Schemas | Add JSON Schema or protobuf definitions for event, command, result manifest, location descriptor, archive manifest. |
| NATS adapter | Implement EventStore append/read\_from/read\_execution on JetStream. |
| Archive service | Implement consumer that writes compressed event segments and manifest.json to object store. |
| Projection service | Implement idempotent projection consumers and checkpoint tables. |
| Resource catalog | Implement noetl:// parser, resolver, resource\_index table, and signed access-plan abstraction. |
| Topology service | Implement region/cell/shard registry with deterministic shard assignment. |
| Policy engine | Start with simple RBAC/ABAC checks; design for OPA/Cedar-style policy backends later. |
| CLI | Add noetl resources resolve, noetl archive inspect, noetl replay, noetl topology inspect. |
| Tests | Projection rebuild test, archive restore test, idempotent event processing test, cross-shard resource resolution test. |

# **Appendix B: First 10 Implementation Steps**

8. Freeze terminology: active event log, command stream, projection store, archive store, resource catalog, location descriptor.  
9. Create event and command schema packages in the core NoETL repository.  
10. Implement JetStream stream bootstrap for one region and one shard.  
11. Implement Postgres checkpoint and projection tables.  
12. Implement EventGateway.append\_event with JetStream acknowledgement and event\_id idempotency.  
13. Implement ProjectionService for execution and task projections.  
14. Implement ArchiveService that writes events to object-store archive bundles.  
15. Implement NoETL URI parser and ResourceCatalog.resolve for local resources.  
16. Modify workers to consume commands and publish events/result manifests instead of large inline payloads.  
17. Add replay command that rebuilds projections from active JetStream or object-store archive.

# **Appendix C: Validation Against Ephemeral Blueprints and Hybrid Cloud Requirements**

This appendix validates the global cloud blueprint against the uploaded Ephemeral Blueprints and Compute-Data Boundary document and turns the remaining hybrid-cloud gaps into explicit architecture requirements. The result is a stricter next-generation NoETL design for AWS, GCP, Azure, and private datacenters using shared sharded regional cells, serverless-first compute, and replaceable queue/storage adapters.

## **C.1 Ephemeral blueprint validation**

The uploaded Ephemeral Blueprints document establishes the architectural contract that NoETL playbooks are ephemeral blueprints, workers execute atomic compute blocks, the gateway acts only as auth/routing/callback gatekeeper, shared cache carries in-flight state, and the event log is the system of record. This blueprint validates against that contract as follows:

* Gateway boundary: Cloudflare and the NoETL gateway terminate sessions, route requests, manage SSE/callbacks, and select a regional cell. They must not read or mutate domain data directly.  
* Playbook boundary: Every data touch, query, mutation, external API call, and credentialed action occurs inside a playbook step governed by policy, retry, idempotency, and audit rules.  
* Worker boundary: Workers are stateless atomic block executors. They may run as Kubernetes/KEDA pools, Cloud Run-style jobs/services, Azure Container Apps, AWS ECS/Fargate/Lambda containers, or datacenter workers, but they do not own durable process state.  
* Shared cache boundary: Arrow IPC, shared-memory, Redis, local NVMe, or object-store cache layers are performance vehicles. They are rebuildable and are never the sole replay authority.  
* Event log boundary: The event log remains the immutable system of record for execution state. Hot event streams are active in the regional cell; completed executions are archived as object-store event bundles and manifests.  
* Credential boundary: Business credentials live in the NoETL keychain and are referenced by aliases in playbook steps. Runtime credentials for gateway, worker, NATS, and service-to-service trust stay at the platform layer.

## **C.2 Coverage checklist for next-generation hybrid global cloud**

The following checklist is required for the blueprint to be complete enough for a next-generation hybrid global cloud spanning AWS, GCP, Azure, and private datacenters.

| Requirement | Design rule | Implementation artifact / validation |
| :---- | :---- | :---- |
| Catalog-driven query routing | All query, result, and dataset requests route through the Resource Catalog / Registry. The catalog resolves noetl:// URNs to region, shard, storage adapter, policy, and compute placement. | Implement QueryRouter \+ RoutePlan \+ CatalogResolver. Validate routing to Postgres, ClickHouse, BigQuery, Snowflake, Databricks, DuckDB, Athena/Trino, and object-store datasets. |
| Cluster-aware NATS client routing | NATSCommandPublisher must pick the NATS endpoint from URN locality and catalog metadata, not static config alone. | Implement NatsEndpointResolver using tenant/org/region/zone/cluster. Emit command.route.selected and command.route.failed events for replay and audit. |
| Per-tenant NATS accounts | The NATS supercluster generator must create account-level isolation for tenants and optionally projects/labs. | Generate NOETL platform account plus TENANT\_\* accounts, subject exports/imports, quotas, JWT/operator config, and tenant-scoped JetStream limits. |
| Cross-cluster stream mirror/source | Use JetStream mirror/source for regional replica and aggregation patterns. Commands should remain owner-routed; events and projection notifications may mirror/source across cells. | Generate mirror/source manifests for NOETL\_EVENTS, NOETL\_PROJECTIONS, catalog-change streams, and archive notification streams. Validate failover and replay semantics. |
| Registered PayloadStore spill path | Every storage-tier spill goes through PayloadStoreRegistry and returns a typed PayloadReference. Workers must not write raw provider URIs without registration. | Add spill policy to TempStore/Arrow cache/outbox path. Validate filesystem, S3, GCS, Azure Blob, SeaweedFS/MinIO S3-compatible stores. |
| Replay URI adapter resolution | ReplayPayloadResolver must resolve s3://, gs://, azure://, abfs://, file://, and noetl:// references through the correct adapter and return bounded checksum/shape summaries. | Add adapter registry tests for all supported schemes. Replay must fail closed if a payload reference is unresolved unless an explicit degraded replay mode is requested. |
| Process-emulator compliance fixture | Cloud adapters must join the same parametrized compliance suite using local emulators where possible. | Add CI fixture using Azurite for Azure Blob, fake-gcs-server for GCS, moto or LocalStack for S3, and SeaweedFS/MinIO for S3-compatible object stores. |

# **Appendix D: Catalog-Driven Query Routing and Resource Resolution**

Catalog-driven query routing is the core mechanism that makes the shared sharded model usable across global regions. Clients and workers must not infer where data lives from bucket names, database hostnames, or NATS subjects alone. They resolve a logical resource identifier through the Resource Catalog and receive a signed, policy-filtered route plan.

## **D.1 Query routing flow**

client/gateway/worker  
  \-\> ResourceCatalog.resolve(noetl://tenant/project/ns/resource@version)  
  \-\> PolicyEngine.authorize(subject, action, resource, context)  
  \-\> QueryRouter.plan(resource, locality, cost, freshness, policy)  
  \-\> StoreAdapter.execute(plan) or ComputePlanner.dispatch(plan)  
The query router chooses the closest safe execution point, not always the physically closest database. For regulated data, the selected route may force in-region compute. For cost-sensitive jobs, the selected route may prefer a cheaper region or precomputed projection. For high-throughput analytics, the selected route may use ClickHouse, BigQuery, Redshift, Synapse/Fabric, Snowflake, Databricks, DuckDB, Trino/Athena, or a tenant-owned database adapter.

## **D.2 RoutePlan contract**

{  
  "resource\_uri": "noetl://tenant/project/lab/dataset/sample@v3",  
  "selected\_region": "us-west-2",  
  "selected\_cell": "aws-usw2-cell-03",  
  "store\_kind": "clickhouse | postgres | bigquery | s3 | gcs | azure\_blob | duckdb | qdrant | external",  
  "storage\_uri": "s3://... | gs://... | azure://... | noetl://...",  
  "compute\_kind": "cloud\_run | kubernetes | fargate | azure\_container\_apps | datacenter\_worker | gpu\_pool | qpu\_adapter",  
  "credential\_ref": "keychain://tenant/project/credential/alias",  
  "policy\_decision\_id": "pol\_dec\_...",  
  "freshness": {"mode": "strong | bounded | eventual", "max\_lag\_seconds": 30},  
  "movement": {"mode": "compute\_to\_data | data\_to\_compute | replica | deny"}  
}

## **D.3 Query routing rules**

* Prefer compute-to-data for large datasets, regulated datasets, and object-store partitions larger than the configured movement threshold.  
* Prefer serverless container execution for short-lived, stateless, tenant-isolated workloads when the required payloads are available through registered PayloadStore adapters.  
* Prefer Kubernetes/KEDA workers for durable consumers, projector StatefulSets, local shared-memory cache, custom networking, GPU/TPU/QPU adjacency, and datacenter execution.  
* Prefer ClickHouse or cloud analytical warehouses for cross-tenant aggregate dashboards only after policy filtering and tenant-level aggregation rules have been applied.  
* Record every route decision as an event so replay, billing, policy audit, and incident review can reconstruct why a region, store, and compute substrate were chosen.

# **Appendix E: Cluster-Aware Event Fabric Routing**

## **E.1 NATSCommandPublisher locality routing**

NATSCommandPublisher must become cluster-aware. Instead of publishing all commands to one configured endpoint, it asks the catalog and topology resolver for the best endpoint for the target URN/resource locality.

publish(command):  
  locator \= NoetlResourceLocator.parse(command.target\_urn)  
  locality \= locator.locality()  \# tenant/org/region/zone/cluster/node/worker when present  
  endpoints \= NatsEndpointResolver.resolve(locality, tenant, purpose="command")  
  selected \= EndpointPolicy.choose(endpoints, health, cost, affinity, failover\_policy)  
  publish\_to(selected, subject=locator.to\_nats\_subject(), payload=command)  
  emit command.route.selected with endpoint, account, region, cluster, and fallback chain  
For Cloud Run-style execution, the selected endpoint may be a regional NATS leaf/gateway endpoint or an HTTP-to-NATS command ingress. For Kubernetes, the selected endpoint may be the in-cluster NATS service. For private datacenters, the selected endpoint may be a private gateway, tunnel, or customer-managed NATS/Kafka adapter registered in the catalog.

## **E.2 Replaceable event and queue fabric**

NATS JetStream remains the reference fabric, but NoETL must keep the event/queue fabric behind ports so customers can use the most cost-effective provider-native service when appropriate.

* NATS JetStream / supercluster: reference active event log, durable consumers, low-latency worker commands, projectors, KEDA scaling, and cross-datacenter gateway mesh.  
* Kafka / Redpanda / cloud Kafka: high-throughput event streaming where customers already operate Kafka or need ecosystem compatibility.  
* Redis Streams: lightweight local or edge command/event fabric for small deployments and cache-adjacent workloads.  
* GCP Pub/Sub: GCP-native command and event delivery for serverless workers; canonical long-term replay still requires object archive or database/event-store backing.  
* AWS SQS/SNS/EventBridge: AWS-native command queues, fanout, event routing, and serverless invocation paths.  
* Azure Service Bus/Event Hubs/Event Grid: Azure-native queues, streams, and event delivery for enterprise/Azure Container Apps patterns.

## **E.3 Per-tenant NATS accounts in the supercluster generator**

The NATS topology generator should emit account-level tenancy by default. Account boundaries enforce subject visibility, JetStream limits, quotas, and operator visibility while still allowing controlled subject exports/imports for shared resources and cross-tenant computation.

accounts:  
  NOETL\_PLATFORM:  
    subjects: "$SYS.\>", "noetl.catalog.\>", "noetl.ops.\>"  
  TENANT\_\<tenant\_id\>:  
    exports:  
      \- "noetl.event.\<tenant\>.\>"  
      \- "noetl.result.\<tenant\>.shared.\>"  
    imports:  
      \- from: NOETL\_PLATFORM  
        subject: "noetl.catalog.resolve"  
    limits:  
      jetstream\_storage: tenant\_quota  
      jetstream\_streams: tenant\_stream\_limit  
      max\_connections: tenant\_connection\_limit

## **E.4 Cross-cluster JetStream mirror/source**

Cross-cluster JetStream mirror/source must be generated explicitly. It should not be an accidental side effect of subject naming. Use mirror for a read-only regional replica of a stream. Use source for fan-in, aggregate, or filtered stream composition. Command ownership must remain clear: commands route to the owning cell; events, catalog changes, projection notifications, and archive notifications may mirror/source across cells.

* Mirror NOETL\_EVENTS from home cell to warm standby cells when fast regional failover or local replay is required.  
* Source selected tenant/project event streams into global audit, billing, cost, or observability streams.  
* Keep NOETL\_COMMANDS owner-routed to avoid duplicate execution, unless the command is explicitly designed as idempotent fanout.  
* Persist mirror/source topology in the Resource Catalog so replay can tell whether an event came from a home stream, mirror, or source aggregation.

# **Appendix F: PayloadStore, Replay, and Compliance Fixtures**

## **F.1 Storage-tier spill through registered PayloadStore**

All storage-tier spill paths must route through a registered PayloadStore. This applies to Arrow IPC frame spill, outbox payload bytes, worker temporary outputs, result bundles, cache eviction, and archive generation. The store returns a canonical PayloadReference that can be persisted in events and replay manifests.

payload\_ref \= PayloadStoreRegistry  
  .for\_policy(tenant, project, region, payload\_shape, size\_bytes)  
  .put(bytes\_or\_stream, metadata={  
      "content\_type": "application/vnd.apache.arrow.file | application/json | application/octet-stream",  
      "checksum": "sha256:...",  
      "producer\_execution\_id": "exec\_...",  
      "locality": "aws/us-west-2/cell-03"  
  })

* Do not let tools write raw s3://, gs://, or azure:// URIs directly into replay-critical event payloads.  
* Store the durable locator, checksum, content type, schema reference, size, region, storage class, and producing execution ID.  
* Allow direct provider URIs only as physical locations behind a typed PayloadReference or ResourceLocation record.  
* Treat shared-memory and local-NVMe Arrow cache as Tier 1.5 optimization; a durable PayloadReference must exist before cache garbage collection can make replay impossible.

## **F.2 Replay adapter resolution**

Replay must resolve durable payload references through the same adapter registry used by runtime writes. It must support logical NoETL URIs and provider-native URIs while preserving tenant policy and bounded replay behavior.

scheme \-\> adapter  
noetl://     ResourceCatalogResolver \-\> PayloadStoreAdapter  
s3://        S3PayloadStore or S3-compatible adapter  
gs://        GCSPayloadStore  
azure://     AzureBlobPayloadStore  
abfs://      Azure Data Lake / Blob adapter  
file://      FilesystemPayloadStore  
seaweed://   SeaweedFS adapter or S3-compatible adapter  
minio://     S3-compatible adapter  
ReplayPayloadResolver should return deterministic summaries by default: checksum, row count, Arrow schema fingerprint, JSON shape summary, byte size, and resolution status. Full payload bodies should be opt-in and bounded by policy.

## **F.3 Process-emulator compliance fixture**

Cloud payload adapters need a process-emulator compliance fixture so they can join the same parametrized test suite without requiring live AWS, GCP, or Azure accounts.

* Azurite for Azure Blob and ADLS-compatible test paths.  
* fake-gcs-server for GCS object-store behavior.  
* moto or LocalStack for S3 behavior and AWS SDK compatibility.  
* SeaweedFS or MinIO for S3-compatible in-house object storage.  
* A single pytest parametrized compliance suite for put/get/head/delete/list, metadata sidecars, checksum validation, atomic write expectations, region/locality metadata, replay resolution, and failure injection.  
* CI profiles: fast unit mocks, process-emulator integration tests, and optional live-cloud certification tests guarded by credentials and cost controls.

# **Appendix G: Cross-Region Supercomputer Setup Mode**

The cross-region supercomputer mode combines all supported components into a single operating model for scientific, AI, enterprise, and quantum-cloud workloads. This mode is not a single cluster. It is a federation of regional cells whose resources are cataloged, policy-controlled, and addressable through NoETL resource locators.

## **G.1 Combined topology**

Cloudflare global entrypoints  
  \-\> NoETL Gateway / API / callback ingress  
  \-\> Resource Catalog \+ Policy Engine \+ QueryRouter  
  \-\> Event/Queue Fabric Port  
       \- NATS supercluster reference  
       \- Kafka / Redis / cloud-native queue adapters where required  
  \-\> Compute Plane  
       \- Cloud Run / serverless containers first  
       \- Kubernetes \+ KEDA for durable workers/projectors/cache/GPU/TPU/QPU/datacenter  
       \- AWS ECS/Fargate/Lambda containers, Azure Container Apps, GCP Cloud Run Jobs  
  \-\> Payload and Data Plane  
       \- S3 / GCS / Azure Blob / MinIO / SeaweedFS / Ceph  
       \- Postgres / AlloyDB / Cloud SQL / Aurora / Azure PostgreSQL  
       \- ClickHouse / BigQuery / Redshift / Synapse-Fabric / Snowflake / Databricks / DuckDB  
       \- Qdrant / OpenSearch / vector and search adapters  
  \-\> Replay, archive, lineage, billing, and provenance services

## **G.2 Quantum-cloud positioning**

For quantum-cloud use, NoETL should treat QPU access as one compute adapter inside a hybrid classical/quantum operating system. NoETL should not assume every workload benefits from quantum execution. The scheduler should classify tasks by tool capability, data movement cost, queue wait, provider availability, policy, and expected value.

* Classical preprocessing and postprocessing should run near the data using serverless containers or Kubernetes pools.  
* GPU/TPU workloads should route to specialized regional pools when acceleration is justified and policy allows data movement.  
* QPU tasks should route through provider adapters that expose queue time, shot count, circuit limits, cost, region, and result provenance.  
* Every quantum result should be stored as a cataloged resource with payload references, execution lineage, provider metadata, calibration/context references, and replay evidence.  
* Cross-region sharing should use resource grants and policy-controlled replicas, not direct bucket credentials or unmanaged copied files.

## **G.3 Repository work items added by this validation**

* Implement QueryRouter, RoutePlan, and catalog-driven query execution adapters.  
* Implement NATSCommandPublisher endpoint selection by URN/locality and catalog route metadata.  
* Extend NATS supercluster generator with per-tenant accounts, quotas, and subject export/import templates.  
* Add JetStream mirror/source manifest generator and validation smoke tests.  
* Force Arrow/outbox/cache spill through PayloadStoreRegistry with durable PayloadReference output.  
* Extend ReplayPayloadResolver to handle s3://, gs://, azure://, abfs://, file://, noetl://, and S3-compatible object stores.  
* Add process-emulator compliance fixtures: Azurite, fake-gcs-server, moto/LocalStack, MinIO/SeaweedFS.  
* Add serverless compute adapters for Cloud Run, Cloud Run Jobs, AWS ECS/Fargate/Lambda container paths, and Azure Container Apps where tasks are stateless and bounded.  
* Add cost-aware placement metrics covering queue wait, egress, compute cost, storage class, serverless cold starts, and GPU/TPU/QPU provider queues.

# **Appendix H: Rust Migration Path and Unified Executor Roadmap**

This appendix sets the technical-direction decision for moving the runtime hot path to Rust over the long term while protecting the production Python platform (`noetl/noetl` v2.103.x) that just shipped all seven phases of the v2 distributed-runtime spec. It is the binding plan for the work the next several quarters will execute against.

## **H.1 Current Rust footprint**

| Repository | Crate | LoC | Role | Current state |
| :---- | :---- | :---- | :---- | :---- |
| `noetl/cli` | `noetl` | ~10.7k | Production CLI; ships the `noetl` binary; includes `playbook_runner.rs` for partial local-mode playbook execution. | v2.17.1, mature. |
| `noetl/gateway` | `noetl-gateway` | mature | Production gatekeeper-only edge service. Auth, SSE, subscription routing. | v2.12.0, mature. |
| `noetl/tools` | `noetl-tools` | ~7.3k | Shared tool library — 14 tool kinds: http, postgres, duckdb, ducklake, python (subprocess), rhai, shell, snowflake, transfer, playbook, secrets, script, noop, plus the registry, context, auth, template, and error modules. | v1.0.0, decent breadth; no Arrow yet. |
| `noetl/server` | `noetl-server` | ~13.8k (engine 1,967 LoC) | Control-plane skeleton split out of the monorepo. | v1.0.3, early — ~15-20% feature parity with the Python engine. |
| `noetl/worker` | `noetl-worker` | ~1.9k | Worker skeleton — NATS pull consumer that dispatches to `noetl-tools`. | v1.0.0, skeleton. |

The full production engine, projector, frame-shaped cursor loops, replay services, frame/stage projections, `ArrowIpcSharedMemoryCache`, MCP catalog architecture, DSL parser/planner/render layer, and credential/keychain resolution still live in `noetl/noetl` (Python, ~89k LoC). All seven v2-spec phases ship from there today.

## **H.2 Decision: hybrid execution, Rust-first on the hot path**

The runtime should move toward Rust where Rust earns its keep and stay Python where Python's productivity is unmatched. The decision is hybrid by intent, not by accident.

| Dimension | Python today | Rust target | Why this shape |
| :---- | :---- | :---- | :---- |
| `handle_event` tail latency | p90 = 140 ms after five rounds of profiling and elision (see `noetl/ai-meta#29`) | p90 ~10–30 ms with no tuning effort | 5–10× headroom that compounds across worker count. |
| Worker memory footprint | ~250 MB resident per pod | ~30–60 MB | 4–8× more workers per node; cheaper KEDA scale-out. |
| Arrow IPC consumer | `pyarrow` ABI binding — copy on every read | `arrow-rs` mmap — true zero-copy | The compounding win that justifies a Rust worker existing at all. |
| Type safety on credential / `_ref` / keychain envelopes | Runtime assertions plus redaction carve-outs | Compile-time `enum` exhaustiveness | Catches the specific bug class hit several times during the keychain rollout. |
| Deployment artifact | Python interpreter plus virtualenv plus ~200 wheels | Single statically linked binary | Faster pod cold-start; smaller container images. |
| DSL parser / planner / replay analytics / MCP catalog | High productivity; rarely a hot path | Not a Rust priority | Rewrite cost not justified by Rust gains in low-frequency, high-complexity code. |
| Engine state machine (`_handle_event_inner`) | Mature, well-tested, recently optimised | Likely Rust phase R-4 if load data supports it | Decision deferred until measured production need exists. |

The blueprint does not endorse a full Python-to-Rust rewrite of the production platform. A rewrite restarts the regression-cost clock for code that already absorbed the v2-spec phases and the post-spec performance work.

## **H.3 The architectural hinge: unified CLI + worker executor**

`repos/cli/src/playbook_runner.rs` already executes playbooks locally by invoking the `noetl-tools` crate inline. `repos/worker` executes the same `noetl-tools` calls but pulls commands from a NATS durable consumer. The two paths are roughly 95% identical execution logic and 5% command-source plumbing. Unifying them around a shared executor crate is the highest-leverage early step.

Target layout:

```
repos/executor/   <-- new crate noetl-executor
  Cargo.toml
  src/
    lib.rs
    runtime.rs            // ExecutionContext, EventEmitter, CredentialResolver
    source.rs             // trait CommandSource { async fn next() -> Option<Command>; }
    sources/
      local_playbook.rs   // parses YAML, generates commands inline (CLI run mode)
      nats.rs             // subscribes to NATS durable consumer (worker mode)
    dispatch.rs           // routes Command -> tool kind -> noetl-tools registry
    events.rs             // emits noetl events; pluggable EventSink trait
    state.rs              // in-memory ExecutionState mirror with replay-friendly shape

repos/cli/        <-- depends on noetl-executor; uses LocalPlaybookSource
repos/worker/     <-- depends on noetl-executor; uses NatsCommandSource + persistent EventSink
```

Both `noetl run --runtime local <playbook.yaml>` and the worker daemon flow through the same execution core. The CLI gets full distributed-runtime semantics in local mode for free (event log, replay, credential resolution); the worker gets the CLI's ergonomic single-binary debug surface. Future tools added to `noetl-tools` are available to both paths from day one.

Existing CLI features that move into the shared crate:

* Tool dispatch and kind resolution from `playbook_runner.rs`.
* Credential / keychain `$noetl_ref` resolution (currently CLI-side).
* Template rendering against the merged step context.
* Event-emission semantics matching the Python worker's `noetl.runtime.events.report_event`.

## **H.4 Apache Arrow-native data plane in Rust**

Adopt the `arrow-rs` crate family ([arrow.apache.org/rust/arrow](https://arrow.apache.org/rust/arrow/index.html)) as the columnar substrate for the Rust worker. Three immediate use cases:

1. **Zero-copy IPC consumer.** Mirror the Python `ArrowIpcSharedMemoryCache` API in a new `noetl-arrow-cache` crate. The Rust consumer mmap-reads a Python-produced segment without serialization or copy. Bidirectional: Rust producers emit `IpcHint` records that Python consumers read through the existing `TempStore.get_ipc_bytes` fast path.
2. **Apache Arrow Flight endpoint.** Add a Flight gRPC server on the worker for cross-pod / cross-node IPC retrieval. Closes the cross-language zero-copy gap noted in section 14 (Apache Arrow IPC Tier 1.5 payload plane).
3. **Frame projection over `RecordBatch`.** The cursor-loop frame model maps naturally to Arrow `RecordBatch`. The Rust frame projector ingests Feather V2 segments produced by Python or Rust workers, applies the planner's reduce, and emits the same `frame.committed` envelope shape.

The `arrow-rs` ecosystem also brings `arrow-flight`, `arrow-ipc`, `parquet`, and `datafusion`. Each becomes available as a tool kind without re-engineering: a future `kind: datafusion` step runs SQL over Arrow `RecordBatch` inputs without leaving the worker process.

Constraints to honour:

* The `IpcHint` envelope shape is fixed by the Python implementation. The Rust side conforms; do not invent a parallel shape.
* `noetl-arrow-cache` releases segments by lease, not by reference count. Same eviction policy as Python, same TTL defaults, same Prometheus counter names so dashboards keep working.
* Durable PayloadStore reference remains mandatory before any cache GC can run. Arrow IPC is a Tier 1.5 accelerator, never the system of record.

## **H.5 Phased migration plan**

The plan is structured so each phase delivers measurable value and has a clear stop criterion. Sunk-cost protection is explicit.

### **Phase R-0 — blueprint alignment (this appendix)**

* This document update fixes the stale line-871 paragraph on Arrow IPC Tier 1.5 implementation status and adds the migration roadmap.
* No code change.
* Exit: this appendix lands.

### **Phase R-1 — `noetl-executor` shared crate (~1–2 months)**

* Extract local execution logic from `repos/cli/src/playbook_runner.rs` into a new `repos/executor/` crate.
* Define the `CommandSource` trait with `LocalPlaybookSource` and `NatsCommandSource` implementations.
* Both `repos/cli` (`noetl run --runtime local`) and `repos/worker` (NATS daemon) depend on `noetl-executor`.
* `noetl-tools` stays the tool registry.
* Existing CLI tests pass against the new core.
* Ship criterion: ≥80% shared code path between the CLI local-mode and worker NATS-mode execution.
* Stop criterion: if extraction creates more abstraction than it removes, keep the two paths separate and revisit unification after Arrow integration (R-2).

### **Phase R-2 — Apache Arrow Rust integration (~1 month, parallel to R-1)**

* Add `arrow`, `arrow-ipc`, `arrow-flight` to the `noetl-tools` workspace.
* Implement `noetl-arrow-cache` crate as the Rust mirror of `ArrowIpcSharedMemoryCache`.
* Rust worker consumes Python-produced `IpcHint` segments with measurable zero-copy.
* Arrow Flight gRPC endpoint on the worker.
* Benchmark target: ≥5× over `pyarrow` round-trip on a 1M-row Parquet through the IPC fast path.
* Stop criterion: if `pyarrow`'s ABI binding is already meeting workload needs (verify against production timing fields in `batch.completed.context`), deprioritise Arrow Flight to backlog and keep Rust-only zero-copy for the IPC cache.

### **Phase R-3 — Rust worker tool parity (~2–3 months)**

* Extend `noetl-tools` to match the Python worker's tool-kind surface for the production playbook mix.
* Add keychain `$noetl_ref` resolution, response-boundary credential redaction, MCP-protocol agent dispatch, full event-emission semantics.
* KEDA scales Rust and Python workers off the same NATS subjects; the orchestrator picks the worker class by tool kind.
* Ship criterion: the travel and glut-probe playbooks run end-to-end on a Rust worker with the same `batch.completed.context` shape as the Python worker.
* Stop criterion: if ≥30% of the production tool-kind surface requires Python subprocess fallback (long-tail Python tools without a Rust port), declare the worker hybrid (Rust shell handling the common cases, Python worker handling the tail) and stop here.

### **Phase R-4 — Rust server hot path + Polars-pattern Python wrapper (~6 months in)**

R-4 is no longer a deferred decision.  The endpoint of the migration is the **Polars pattern**: Rust is the runtime, Python is a wrapper that ships in the same `pip install noetl` distribution.  See § H.9 for the full shape; the deliverables for R-4 itself are:

* Port `_handle_event_inner`, the cascade event-log batching, the save_state coalescing, and the projector hot path from `noetl/noetl` (Python) into `noetl/server` (Rust).  Keep Python for replay analytics, MCP catalog tooling, DSL parser, and the long-tail of frame-projector logic — code that is low-frequency or high-complexity and does not benefit from Rust.
* Ship the Python PyO3 wrapper (`pip install noetl`) that embeds the Rust binaries and exposes the existing `noetl/noetl` API surface so current Python users migrate without touching their playbooks.
* Ship `noetl-sdk` (pure Python, no Rust binaries) for notebook users and remote clients who don't want the embedded runtime.
* Ship `noetl-tools-python` so Python callables registered as `@noetl.tool` keep working — dispatched across the PyO3 FFI boundary with zero-copy Arrow `RecordBatch` interop.

Ship criterion: `pip install noetl` installs the Rust runtime + Python wrapper from one wheel and runs the existing Travel and glut-probe playbooks unchanged.  Stop criterion: if PyO3 binding overhead measurably regresses the worker tail latency past round-5 baselines, ship Rust-only and provide `noetl-sdk` as the Python user surface (no embedded runtime).

## **H.6 What does not change**

* The Python platform stays the production control plane through all of R-1 / R-2 / R-3.  R-4 introduces the Polars-pattern Python wrapper (§ H.9) so Python users keep their existing programmatic surface even after the runtime moves to Rust.
* The v2-spec phase audit (table on line 968) remains the source of truth for distributed-runtime spec status. Rust migration phases are tracked separately under this appendix.
* The wire contracts — `noetl.event` shape, NATS subject patterns, `batch.completed.context` field catalogue, `IpcHint` envelope — do not change. Rust adoption is invisible to playbook authors and to the gateway.
* Tool authors continue to add tool kinds in `noetl-tools` (Rust) and `noetl/tools/` (Python). The orchestrator picks the worker class by tool kind; both shells coexist.

## **H.7 First implementation steps**

The first set of pull requests that turn this appendix into code, in dependency order:

1. **`noetl/executor` repository bootstrap.** New `repos/executor/` Rust crate with `lib.rs`, `CommandSource` trait, `LocalPlaybookSource` extracted from `repos/cli/src/playbook_runner.rs`, `dispatch.rs` wired to `noetl-tools` registry. CI passing.
2. **`noetl/cli` depends on `noetl-executor`.** Replace the inline local-mode runner with the shared crate. CLI integration tests pass unchanged.
3. **`noetl/worker` depends on `noetl-executor`.** Replace the worker's NATS-dispatch path with a `NatsCommandSource` plus the shared executor. End-to-end test against a local NATS shows the same event-emission shape as the Python worker.
4. **`noetl-arrow-cache` crate.** Implements the Python `ArrowIpcSharedMemoryCache` API in Rust. Unit tests round-trip an `IpcHint`. Benchmark against `pyarrow` baseline.
5. **Arrow Flight endpoint on `noetl/worker`.** Cross-pod IPC retrieval test green; metric counters published alongside the existing Python projector's `summary["ipc"]` block.

Each PR ships with the same engineering discipline used through `noetl/ai-meta#29`: per-phase timing instrumentation, before/after measurement, an ai-task issue tracking the round, and lockstep wiki + docs updates.

## **H.8 Open questions to decide before R-1 starts**

* Should `noetl-executor` live as a fourth top-level repository, or as a workspace crate inside `noetl/cli`? Workspace crate is faster to bootstrap; separate repository is cleaner for the eventual `noetl-worker` cargo dependency. Recommendation: workspace inside `noetl/cli` for R-1, promote to standalone when `noetl-worker` is ready to depend on it.
* Should the Rust worker speak the same `batch.accepted → batch.processing → batch.completed` lifecycle as the Python worker, or define its own status taxonomy? Recommendation: same lifecycle. Cross-stack observability is more valuable than schema purity.
* Should `noetl-arrow-cache` and `noetl-executor` be published to crates.io or stay internal? Recommendation: stay internal until R-3 ships and the API has stabilised.

## **H.9 The endpoint: Polars-pattern Python wrapper around the Rust runtime**

The long-term shape of NoETL — once the Rust migration concludes — is the same shape that Polars uses to replace pandas in the Python data ecosystem: **a Rust core with a Python wrapper that ships in the same distribution**.  Python users keep their ergonomic surface (`import noetl as nt`, `@noetl.tool`, notebook-friendly types).  The runtime they call into is Rust.  Both halves ship in one `pip install noetl` wheel built with PyO3 + maturin, the same toolchain Polars, Pydantic V2, Ruff, and Ty use today.

This is what makes the migration a one-way change instead of a tower of optional steps: R-4 isn't a deferred "should we rewrite the server" question — it's the ship date of the Python wrapper that lets the Rust takeover happen without breaking any Python user.

### **H.9.1 Three Python surfaces**

The Python distribution splits into three packages, each with a distinct audience:

| Package | Ships | Audience | Use when |
| :---- | :---- | :---- | :---- |
| `pip install noetl` | PyO3 wrapper + embedded Rust binaries (`noetl-server`, `noetl-worker`, `noetl-cli`, `noetl-executor`, `noetl-tools`, `noetl-arrow-cache`) | Today's `noetl/noetl` Python users and Jupyter notebook authors who want a single-install runtime. | Local execution, embedded runtime in tests, prototyping, single-host deployments. |
| `pip install noetl-sdk` | Pure Python types + thin client to a remote NoETL server | Data scientists, notebook users, partner integrations who don't want the embedded runtime. | Talking to a remote `noetl/server` over HTTP/gRPC, no local Rust binaries needed. |
| `pip install noetl-tools-python` | PyO3 hooks that register Python callables as `noetl-tools` kinds at runtime | Anyone authoring tools as Python functions (`@noetl.tool def my_transform(...)`) | The Python tool surface that stays Python after R-3 — long-tail tools without a Rust port. |

This mirrors Polars's split (`polars` → Rust core + Python wrapper; `polars-arrow` / `polars-core` available separately on crates.io for Rust consumers).  The pattern is mature and the tooling is proven.

### **H.9.2 FFI shape and Arrow zero-copy across the boundary**

The PyO3 boundary is not free — but it doesn't have to be expensive either, because the data plane is Arrow.

* **Control plane** (`noetl.run(playbook="x.yaml", workload={...})`) crosses PyO3 once per playbook invocation.  Marshalling cost is negligible relative to playbook duration.
* **Tool dispatch** for a Rust tool kind never crosses PyO3 — `noetl-executor` calls `noetl-tools` directly.  Python is not in the loop.
* **Tool dispatch** for a `noetl-tools-python` (Python-callable) tool kind crosses PyO3 once per command, with the input + output as Arrow `RecordBatch` references.  PyO3's `pyarrow` interop hands the same Arrow buffer to Python without copy.  This is the same path Polars uses to expose Rust DataFrames to Python in zero-copy form.
* **Arrow IPC cache** (`noetl-arrow-cache`) is bidirectional: Rust producers emit `IpcHint` segments that the Python wrapper mmap-reads; Python tool outputs land in the same shared-memory region for downstream Rust consumers.

The Python side never sees a serialization round-trip on hot-path data.  Where Python touches the data is exactly where Polars touches it — through `pyarrow`-compatible buffers.

### **H.9.3 What the migration looks like to a Python user**

* **Before** (today, `noetl/noetl` v2.103.x): `pip install noetl-python` (or whatever the Python distribution is named); Python interpreter runs the engine; tools are Python functions; control plane is Python.
* **After** (R-4 ships): `pip install noetl`; Rust binaries are embedded; the existing Python API surface (`noetl.run`, `noetl.execute_playbook`, decorators) is preserved by a PyO3 wrapper that delegates to the Rust binaries; existing Python tools registered via `@noetl.tool` keep working through `noetl-tools-python`.
* **Their playbooks are unchanged.**  YAML doesn't care which language the runtime is written in.
* **Their performance improves** — the cumulative gains of R-1 through R-4 land for free at upgrade time.

This is the same migration path pandas users take to Polars: install the new package, change the import, and ship.  Most playbook authors won't even need to change the import — the `noetl` package name stays the same; only the wheel contents change.

### **H.9.4 Tradeoffs to honour**

* **Wheel size grows.** PyO3 wheels with embedded Rust binaries are larger than pure-Python wheels.  Polars ships ~30 MB wheels; NoETL's runtime will likely be similar.  Acceptable for a distribution that includes a database client (`duckdb`), HTTP client, Arrow, and a NATS client.
* **Multi-platform wheel building gets harder.**  Need `cibuildwheel` (or equivalent) producing `manylinux_2_28_x86_64`, `manylinux_2_28_aarch64`, `macosx_*_universal2`, and `win_amd64` wheels.  The toolchain is well-trodden — Polars's CI is a usable template.
* **GIL coordination.**  Python tools registered via `noetl-tools-python` run under the GIL by default.  Truly parallel Python tools (rare, but used in the `python` tool kind for CPU-bound transforms) need the tool author to release the GIL explicitly (`#[pyfunction(text_signature = "...", pass_module = false)]` + `py.allow_threads(...)`).  Document this in the `@noetl.tool` decorator docs; provide an opt-in `gil_release=True` flag.
* **PyO3 ABI compatibility.**  Pin the PyO3 version per release and validate against the supported Python versions (3.10+ recommended).  Use the `abi3` feature so one wheel works across Python minor versions.

### **H.9.5 What this changes in the migration plan**

* **R-1, R-2, R-3 are unchanged.**  The Polars pattern is the endpoint; the path to get there is still the phased migration.
* **R-4's ship criterion sharpens.**  Instead of "decide whether to port the server hot path," it's "ship `pip install noetl` with the embedded Rust runtime and the PyO3 wrapper, validated against the existing Travel and glut-probe playbooks."
* **R-5 (out of scope of this appendix, planning placeholder).**  After R-4 lands and Python users migrate, the Python control-plane code paths in `noetl/noetl` can be deleted once telemetry shows no consumers remain.  The `noetl/noetl` repo becomes the PyO3 wrapper repo; the Rust runtime lives in `noetl/server`, `noetl/worker`, `noetl/executor`, `noetl/tools`, `noetl/cli`, and `noetl/arrow-cache`.

### **H.9.6 Reference projects**

* [Polars](https://github.com/pola-rs/polars) — the proof point.  `pl.DataFrame` is a Rust `DataFrame` exposed via PyO3 with Arrow-native interop.  Pandas-compatible enough for migration; 5–50× faster in production benchmarks.
* [Pydantic V2 (`pydantic-core`)](https://github.com/pydantic/pydantic-core) — Pydantic moved its hot path from Python to Rust through PyO3 without breaking its public Python API.  Same pattern, smaller surface.
* [Ruff](https://github.com/astral-sh/ruff) — Rust replacement for `flake8`/`isort`/etc with a Python interface.  Distribution shape (wheel + binary) is a template.
* [Ty](https://github.com/astral-sh/ty) — Astral's new Rust type checker with Python wrapper.  Active project worth tracking for the latest PyO3 patterns.
* [`maturin`](https://github.com/PyO3/maturin) — the build tool that produces PyO3 wheels.  Required toolchain for `pip install noetl`.

### **H.9.7 Naming**

Recommended package names at R-4 ship:

* PyPI: `noetl` (renames over the current Python distribution — coordinate with PyPI maintainers).
* PyPI: `noetl-sdk` (new, pure-Python remote client).
* PyPI: `noetl-tools-python` (new, registers Python callables as tool kinds).
* Crates.io (R-3 / R-4): `noetl-server`, `noetl-worker`, `noetl-cli`, `noetl-executor`, `noetl-tools`, `noetl-arrow-cache`, `noetl-gateway` (the gateway already lives here).
* Crates.io publish flag flips from `publish = false` to `publish = true` per crate as its API stabilises.

The user-visible Python import stays `import noetl as nt`.  Code that runs today against `noetl/noetl` v2.103.x runs unchanged against `pip install noetl` after R-4 lands.