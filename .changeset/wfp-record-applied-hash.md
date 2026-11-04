---
"@authhero/cloudflare-adapter": patch
---

Record the config hash a tenant worker applied on the control plane's tenant row after a successful `sync-defaults` push, so `GET /tenants/{id}/config-sync` stops reporting `drifted: true` and the drift reconcile stops re-enqueuing tenants with their own worker and database. The hash is only recorded while it is still what the tenant's chain resolves to, so a sync that was overtaken by a newer one, or by an edit on a parent, cannot put an older hash over a newer one.
