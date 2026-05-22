# GLUT Probe Design Structure Registry

This example registers GLUT Probe Design as a tenant project in a local NoETL
cloud and processes the first raw data registry: public RCSB PDB structures for
known GLUT isoforms.

## Repository Locations

Within `ai-meta/repos`:

| Repository | Role |
|---|---|
| `repos/e2e` | Owns runnable NoETL fixture playbooks |
| `repos/noetl` | Owns DSL schema, parser, validators, and runtime behavior |
| `repos/docs` | Owns NoETL documentation |
| `repos/glut-probe-design` | Owns tenant project scripts, tasks, memory, and science docs |

The fixture playbook is:

```text
repos/e2e/fixtures/playbooks/data_processing/glut_probe_design/structure_registry.yaml
```

The tenant project script it calls is:

```text
repos/glut-probe-design/scripts/collect_glut_structures.py
```

## Tenant Context

The local NoETL kind setup is treated as the cloud. GLUT Probe Design is treated
as the tenant project:

```yaml
tenant_id: glut-probe-design
organization_id: kadyapam
project_id: glut-probe-design
```

The raw artifact registry is:

```text
gs://glut-probe-design/data/structures/
```

## What The Playbook Does

The structure registry playbook:

1. Validates the tenant IDs, project repository path, bucket URI, and expected
   structures prefix.
2. Runs `scripts/collect_glut_structures.py` in the GLUT tenant project.
3. Writes `data/structures/metadata_index.json` with tenant IDs, object URIs,
   sizes, and SHA-256 checksums for downloaded PDB files.
4. Uploads the manifest, metadata index, and raw PDB files to GCS.
5. Uploads a small run summary under `runs/latest/`.
6. Removes generated raw PDB files and generated manifests from the local Git
   worktree.

## Postgres Boundary

Do not upload raw PDB byte content to Postgres.

Postgres should store queryable metadata and orchestration state:

- tenant, organization, and project IDs
- dataset name
- GLUT isoform IDs, genes, UniProt IDs, PDB IDs, source, and status
- GCS object URIs
- checksums and object generations for exact replay
- execution IDs, transformation status, and derived summary metrics

Raw PDB/SDF/PDBQT files, ligand libraries, model weights, docking poses, and
large generated outputs should remain in object storage.

## Register And Run

Register from `repos/e2e`:

```bash
noetl --server-url http://localhost:8082 register playbook \
  -f fixtures/playbooks/data_processing/glut_probe_design/structure_registry.yaml
```

Run with defaults:

```bash
noetl --server-url http://localhost:8082 run \
  tenants/glut-probe-design/projects/glut-probe-design/data/structures/registry
```

For a dry local metadata pass that does not upload to GCS:

```bash
noetl --server-url http://localhost:8082 run \
  tenants/glut-probe-design/projects/glut-probe-design/data/structures/registry \
  --set upload_to_gcs=false \
  --set cleanup_local_raw=false
```

Validate the playbook shape from `repos/noetl`:

```bash
python scripts/validate_playbooks.py \
  ../e2e/fixtures/playbooks/data_processing/glut_probe_design
```
