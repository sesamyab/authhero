---
"@authhero/multi-tenancy": minor
"@authhero/admin": patch
---

Verify a tenant's config on demand. `GET /api/v2/tenants/{id}/config-sync/verify` compares a tenant's config with what its parents publish, read-only, and answers `ok` with the differences (`missing`, `extra`, `changed`, `stale`, by entity and key, never content) and errors. A tenant that inherits on read is compared the way shadow mode does; a synced tenant is checked with a sync dry run against its own rows, so a deleted or edited copy shows up although the stored hash matches, and a tenant with its own database goes through the `syncDefaults` transport. The tenant's sync status card gets a _Verify_ button.
