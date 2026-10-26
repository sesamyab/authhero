---
"@authhero/multi-tenancy": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"authhero": minor
---

Add the resolved config block for tenant config sync. `buildResolvedConfigBlock` merges a tenant's parent chain (actions, code hooks with their hook code, connections, resource servers and more) and `applyResolvedConfigBlock` materialises it under the tenant's own id with deterministic row ids, a content hash stored in the new `tenants.config_sync_hash` / `config_synced_at` columns (an up-to-date push is a no-op), a dry run, explicit opt-in deletes and a key-ring check that refuses to write when the tenant cannot decrypt a key id in the payload. The drizzle adapter now honours `importMetadata.id` for actions and hook code. `config_sync_*` is ignored on tenant PATCH.
