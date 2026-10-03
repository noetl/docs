---
sidebar_position: 7
title: GCS Tool 
description: Upload local files to Google Cloud Storage as pipeline tasks 
---

# GCS Tool 

:::danger `kind: gcs` has no dispatcher — it will fail at execution
`Gcs` exists in the **server's** validation enum, so a playbook using
`kind: gcs` passes validation and is accepted. But there is **no `gcs` entry in
the worker's tool registry** (`noetl-tools/src/tools/mod.rs`), so the step fails
at dispatch with a tool-not-found error.

Checked for a successor and found none: `artifact` is a get-only alias for
`ResultFetchTool` (it materialises a `noetl://` ref, it does not upload),
`transfer` moves data between **databases**, and the only `gs://` handling in
the registry is `python`'s read-only script loading. The `gcs` strings elsewhere
in noetl-tools belong to the **spool** subsystem, not to a tool kind.

This page is kept rather than deleted because whether `kind: gcs` should exist
is a product decision, not a documentation one — raised for the maintainers. Do
not write new playbooks against it.
:::

The `gcs` tool was intended to upload a local file to Google Cloud Storage
(`gs://...`).

> Note: this tool is for explicit file uploads. For **reference-first** step outputs (ResultRef), see `/docs/reference/result_storage`.

---

## Basic usage

```yaml
- step: upload_file
  tool:
    - upload:
        kind: gcs
        source: "/tmp/output.csv"
        destination: "gs://my-bucket/data/output.csv"
        credential: gcp_service_account
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

---

## Common fields

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Local file path |
| `destination` | string | GCS URI (`gs://bucket/path`) |
| `credential` | string | Credential/keychain reference name |
| `content_type` | string | Optional MIME type |
| `metadata` | mapping | Optional object metadata |

---

## See also
- Result storage (reference-first): `/docs/reference/result_storage`
- Auth & keychain: `/docs/reference/auth_and_keychain_reference`
