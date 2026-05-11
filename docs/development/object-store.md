# Local Object Store Setup

NoETL uses an in-cluster S3-compatible object store for durable large payloads.
The deployment chooser lives in `repos/ops` and supports:

- `seaweedfs` — default, mature backend
- `rustfs` — opt-in backend with S3-compatible API behavior

Both backends expose the same Kubernetes Service:

```text
http://object-store.object-store.svc.cluster.local:9000
```

NoETL continues to use the abstract `s3` storage tier through
`NOETL_S3_ENDPOINT`; the backend choice is a deployment concern.

## Access Details

- **Local API endpoint:** `http://localhost:9000`
- **In-cluster endpoint:** `http://object-store.object-store.svc.cluster.local:9000`
- **Default bucket:** `noetl`
- **Default local credentials:**
  - **Access key:** `noetl-access`
  - **Secret key:** `noetl-secret`

## Automation

Deploy the default SeaweedFS backend:

```bash
cd repos/ops
noetl run automation/infrastructure/object_store.yaml \
  --set action=deploy \
  --set objectstore_kind=seaweedfs
```

Deploy RustFS instead:

```bash
cd repos/ops
noetl run automation/infrastructure/object_store.yaml \
  --set action=deploy \
  --set objectstore_kind=rustfs
```

Check status or remove the backend:

```bash
noetl run automation/infrastructure/object_store.yaml --set action=status
noetl run automation/infrastructure/object_store.yaml --set action=remove
```

## Local Terminal Access

Configure AWS-compatible clients with the local endpoint:

```bash
export AWS_ACCESS_KEY_ID=noetl-access
export AWS_SECRET_ACCESS_KEY=noetl-secret
export AWS_DEFAULT_REGION=us-east-1

aws --endpoint-url http://localhost:9000 s3 mb s3://noetl
aws --endpoint-url http://localhost:9000 s3 cp test.txt s3://noetl/test.txt
aws --endpoint-url http://localhost:9000 s3 ls s3://noetl/
```

## Persistence

For local kind, object data is persisted in:

```text
ci/kind/cache/object-store-data
```

The destroy playbook clears this cache:

```bash
noetl run automation/setup/destroy.yaml
```
