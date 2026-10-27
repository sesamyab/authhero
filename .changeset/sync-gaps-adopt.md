---
"@authhero/multi-tenancy": minor
---

Close the sync gaps from the config inheritance epic: a tenant's own connection, resource server or action with the same key now wins instead of getting a synced copy beside it (reported as `skip ...`, and no unique-index error for resource servers), a newly synced connection is enabled on the tenant's clients that list their connections explicitly, and email provider, branding and prompt settings are replaced when the parent locks them (`override: none` or `enforce`).
