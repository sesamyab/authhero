---
"@authhero/multi-tenancy": patch
---

Make rolling back a synced tenant safer and document the migration. An inheritable control-plane hook is no longer listed twice for a tenant that holds its synced copy of it (for example after flipping `config_sync` back to `inherit-on-read`). Creating a tenant or changing its `config_sync` through the tenants routes now drops the sync mode the runtime remembers for it in that instance (other instances still take up to 30 s); new optional `onConfigSyncChange` on `MultiTenancyConfig`, wired by `initMultiTenant`.
