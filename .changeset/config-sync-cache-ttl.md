---
"@authhero/multi-tenancy": minor
---

Each isolate now remembers a tenant's `config_sync` mode for 10 seconds instead of 30, so it notices a flip within that time, and `initMultiTenant` takes `configSyncCacheTtlMs` to set it. Logins on a deployment that caches the client bundle can still take up to 15 minutes to follow a flip.
