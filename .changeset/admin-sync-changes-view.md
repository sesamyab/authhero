---
"@authhero/multi-tenancy": minor
"authhero": patch
"@authhero/admin": patch
---

Show what a sync changes. The `sync-defaults` result now also carries `rows` (each change as `{entity, key, action}` with `added`, `changed`, `skipped` or `delete`) and a capped `error_messages`, and the tenant Operations page gets a _Config sync changes_ card with the latest preview and sync grouped by entity, plus the same view in an expanded operation. The operations API now accepts `prune` in a sync's input: it was dropped before, so _Remove unshared_ had no effect.
