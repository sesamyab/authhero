---
"@authhero/cloudflare-adapter": patch
---

Record the config hash a tenant worker applied on the control plane's tenant row after a successful `sync-defaults` push, so `GET /tenants/{id}/config-sync` stops reporting `drifted: true` and the drift reconcile stops re-enqueuing tenants with their own worker and database.
