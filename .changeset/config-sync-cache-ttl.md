---
"@authhero/multi-tenancy": minor
---

A change of a tenant's `config_sync` mode now reaches every isolate within 10 seconds instead of 30. The time is how long an isolate remembers a tenant's mode, and `initMultiTenant` takes `configSyncCacheTtlMs` to set it.
