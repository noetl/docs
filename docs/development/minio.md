# Local MinIO Setup

NoETL uses MinIO for local S3-compatible object storage to support storage guidance for large payloads (> 1MB).

## Access Details

- **API Endpoint:** `http://localhost:9000` (mapped from Kind port 30900)
- **Console UI:** `http://localhost:9001` (mapped from Kind port 30901)
- **Default Credentials:**
  - **Access Key:** `minioadmin`
  - **Secret Key:** `minioadmin`

## Automation

You can manage MinIO using the infrastructure playbook in `repos/ops`:

```bash
# Deploy MinIO to kind cluster
noetl run automation/infrastructure/minio.yaml --set action=deploy

# Check status
noetl run automation/infrastructure/minio.yaml --set action=status

# Remove MinIO
noetl run automation/infrastructure/minio.yaml --set action=remove
```

## Local Terminal Access

### Using AWS CLI

Configure a profile or use environment variables:

```bash
export AWS_ACCESS_KEY_ID=minioadmin
export AWS_SECRET_ACCESS_KEY=minioadmin
export AWS_DEFAULT_REGION=us-east-1

# Create a bucket
aws --endpoint-url http://localhost:9000 s3 mb s3://noetl-results

# Upload a file
aws --endpoint-url http://localhost:9000 s3 cp test.txt s3://noetl-results/test.txt

# List files
aws --endpoint-url http://localhost:9000 s3 ls s3://noetl-results/
```

### Using MinIO Client (mc)

```bash
# Alias the local MinIO
mc alias set local http://localhost:9000 minioadmin minioadmin

# Create a bucket
mc mb local/noetl-results

# Copy a file
mc cp test.txt local/noetl-results/
```

## Persistence

Data is persisted in the Kind cluster cache directory: `ci/kind/cache/minio-data`. This directory is cleared when running the destroy playbook:

```bash
noetl run automation/setup/destroy.yaml
```
