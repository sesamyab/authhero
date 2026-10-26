---
"@authhero/multi-tenancy": minor
"@authhero/admin": minor
---

Admin UI for config inheritance. New `GET /api/v2/tenants/{id}/config-sync` (scope `read:tenants`; the control plane for any tenant, a tenant for its own) returns a tenant's parent, sync mode, applied and expected hash, a `drifted` flag, its parent chain and an `inherited` map from the id of each inherited row to the ancestor that published it; `initMultiTenant` wires it and `getConfigSyncStatus` is exported. In the admin: publishing fields (scope, override, enforce) on actions, hooks, connections and resource servers, an inherited-from notice that locks rows whose parent allows no changes, a source column on the lists, parent tenant on create and in settings, a sync status card (with drift and a force sync) on the settings advanced tab and the tenant operations page, and a rollouts page to start, follow, pause and resume fleet rollouts.
