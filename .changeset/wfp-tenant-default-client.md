---
"@authhero/cloudflare-adapter": minor
"@authhero/multi-tenancy": patch
---

A new tenant with its own database gets its default client in that database. `createWfpTenantApp` now runs `provisionDefaultClients` at the end of `/internal/sync-defaults` (needs `TENANT_ID` in the Worker's environment), through the adapter that encrypts the client secret, and skips the Management API client. `initMultiTenant` no longer runs the tenant `afterCreate` sync of the control plane's resource servers and roles for a `wfp` tenant when `databaseIsolation.onProvision` is set. With the default `getAdapters` that sync wrote them to the control plane's own database under the tenant's id, where nothing reads them; a `shared` tenant keeps it.
