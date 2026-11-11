---
"@authhero/multi-tenancy": patch
---

`POST /tenants` requires the `create:tenants` scope. Before, it declared no scope, so any valid management token could create a tenant, while updating and deleting tenants already required `update:tenants` and `delete:tenants`. A token without the scope now gets 403 before the `beforeCreate` hook or provisioning runs. Grant `create:tenants` to the users or clients that create tenants: a self-service flow that lets any signed-in user create a tenant needs it in their roles.

`GET /tenants` still declares no scope, because it lists only the tenants the caller can access. `read:tenants` stays required on the other read routes (`GET /tenants/settings` and the config-sync routes).
