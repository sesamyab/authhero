---
"@authhero/cloudflare-adapter": minor
"@authhero/multi-tenancy": patch
---

A new tenant with its own database gets its default client in that database. `createWfpTenantApp` now runs `provisionDefaultClients` at the end of `/internal/sync-defaults` (needs `TENANT_ID` in the Worker's environment), through the adapter that encrypts the client secret, and skips the Management API client. `initMultiTenant` no longer copies the control plane's resource servers and roles into its own database for a tenant that has `databaseIsolation.onProvision`, where nothing reads them.
