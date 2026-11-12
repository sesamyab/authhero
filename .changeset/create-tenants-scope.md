---
"@authhero/multi-tenancy": patch
---

`POST /tenants` requires the `create:tenants` scope. Before, it declared no scope, so any valid management token could create a tenant, while updating and deleting tenants already required `update:tenants` and `delete:tenants`. Under AuthHero's management API, a token without the scope now gets 403 before the `beforeCreate` hook or provisioning runs. A host that mounts `createMultiTenancy()` or `setupMultiTenancy().app` in its own app does not get that check: it has to authenticate the caller and enforce the declared scopes itself. Grant `create:tenants` to the users or clients that create tenants: a self-service flow that lets any signed-in user create a tenant needs it in their roles.

`GET /tenants` still declares no scope. When a control-plane tenant is configured, it lists only the tenants whose organizations the caller belongs to, unless the caller has a global `admin:organizations` permission. Without a control-plane tenant it lists every tenant. `read:tenants` stays required on the other read routes (`GET /tenants/settings` and the config-sync routes).
