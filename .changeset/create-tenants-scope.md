---
"@authhero/multi-tenancy": patch
---

`POST /tenants` requires the `create:tenants` scope. Before, it declared no scope, so any valid management token could create a tenant, while reading, updating and deleting tenants already required `read:tenants`, `update:tenants` and `delete:tenants`. A token without the scope now gets 403 before the `beforeCreate` hook or provisioning runs. Grant `create:tenants` to the users or clients that create tenants: a self-service flow that lets any signed-in user create a tenant needs it in their roles.
