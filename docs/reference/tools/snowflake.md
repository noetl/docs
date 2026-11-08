---
sidebar_position: 5
title: Snowflake Tool 
description: Execute SQL against Snowflake as pipeline tasks 
---

# Snowflake Tool 

The `snowflake` tool executes SQL statements against Snowflake.

Standard reminders:
- Use `task.spec.policy.rules` for retry/fail/jump/break.
- Prefer reference-first results for large outputs.

---

## Basic usage

```yaml
- step: query_warehouse
  tool:
    - q:
        kind: snowflake
        command: "SELECT current_user(), current_warehouse()"
        auth:
          source: credential
          key: snowflake_prod
          service: snowflake
        spec:
          policy:
            rules:
              - when: "{{ outcome.status == 'error' }}"
                then: { do: fail }
              - else:
                  then: { do: break }
```

---

## Command sources

Snowflake accepts SQL via:
- `command` / `commands` (plain text)
- `command_b64` / `commands_b64` (base64; recommended for transport)

---

## Transfers

For bulk movement between Snowflake and Postgres, prefer `kind: transfer`:
- `/docs/reference/tools/transfer`

---

## See also
- Auth & keychain: `/docs/reference/auth_and_keychain_reference`
- Retry semantics: `/docs/reference/retry_mechanism`
