---
"@authhero/multi-tenancy": minor
"@authhero/cloudflare-adapter": patch
"@authhero/admin": patch
---

Remove synced copies a parent stopped sharing: `sync-defaults` takes `input.prune`, the sync detects stale `sy` rows in the tenant's own database (also over the dispatch transport and `/internal/sync-config`), and a dry run lists them. The tenant Operations page gets a _Remove unshared_ option.
