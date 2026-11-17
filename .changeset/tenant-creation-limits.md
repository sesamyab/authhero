---
"@authhero/multi-tenancy": minor
---

Add `tenantCreationLimits` to `initMultiTenant` to cap how many tenants a non-operator can create. `perUser` (a number, `null` for unlimited, or a function of the user) refuses `POST /tenants` with `403` once the caller owns that many tenants, and a user with a tenant still `pending` cannot create another (`blockWhilePending`, on by default). An operator can raise or lift the limit for one user with `app_metadata.tenant_limit` (a number or `"unlimited"`). Callers holding `delete:tenants`, `admin:organizations`, `create:tenant_operations` or `create:rollouts` are exempt. If the counts cannot be read the request is refused with `503`. Unset, behaviour is unchanged.
