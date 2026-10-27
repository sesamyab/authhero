---
"@authhero/adapter-interfaces": minor
"@authhero/multi-tenancy": minor
"authhero": minor
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"@authhero/cloudflare-adapter": patch
"@authhero/admin": patch
---

Add a `detach` tenant operation: a synced tenant leaves its parent. The copies a sync delivered become the tenant's own rows (or are removed with `clean`), platform rows stay as copies, and the tenant gets the new `config_sync` mode `detached`, no parent and no sync state, so it neither inherits nor is synced again. The tenant Operations page gets _Preview detach_ and _Detach_. `tenants.update` in the kysely and drizzle adapters now clears `parent_tenant_id`, `config_sync_hash` and `config_synced_at` when given an explicit `null`. The operation works on tenants in the control plane's database; a transport for tenants with their own database is a follow-up.
