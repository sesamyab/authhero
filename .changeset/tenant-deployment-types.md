---
"@authhero/multi-tenancy": minor
"@authhero/admin": minor
---

Let a cluster limit which deployment types new tenants may use. `initMultiTenant({ deploymentTypes: { allowed: ["wfp"] } })` makes `POST /tenants` default to `wfp` (with its own D1), refuses `shared`, and stops `PATCH /tenants/settings` from moving a tenant onto a type the cluster can't host. The new `GET /tenants/deployment-options` endpoint tells the admin UI which types to offer; with a single type the choice is hidden. Without the option both types stay available and `shared` remains the default.
