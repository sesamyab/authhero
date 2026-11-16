---
"authhero": minor
"@authhero/multi-tenancy": minor
"@authhero/admin": patch
---

The tenant operations routes on the control plane now check which tenant the caller may reach. Before, any control-plane token with `read:tenant_operations` could read the operations of every tenant, and one with `create:tenant_operations` could enqueue any kind of operation on any tenant.

Operators still reach every tenant: machine tokens and callers holding `create:tenant_operations`, `create:rollouts` or `admin:organizations`, as long as the token is not scoped to an organization (an organization-scoped token carries its organization role's permissions, which the stock Tenant Admin role fills with every management scope). Everyone else reaches only the tenants whose organization they belong to, the rule `GET /tenants` already uses. A tenant they cannot reach answers `404` on `GET /tenants/{id}/operations` and `GET /operations/{id}`, and on `POST /tenants/{id}/operations`.

New scope `retry:tenant_provisioning` (added to the seeded Management API scopes): on its own it only allows `{ "kind": "upgrade" }` on a reachable tenant whose `provisioning_state` is `failed`, and any other kind or state is `403`. `create:tenant_operations` stays the operator scope. The admin's setup page offers Retry to users with either scope. Resource servers seeded before this scope existed need it added; `selfServiceSignup` adds it for you.

`selfServiceSignup` now also gives the `Tenant Creator` role `read:tenant_operations` and `retry:tenant_provisioning`, so a new user sees the steps and failure reason of their own tenant's provisioning and can retry it. It also adds those scopes to the Management API resource server if it does not define them. **Upgrade authhero and `@authhero/multi-tenancy` together**: an authhero without the reach check would let any holder of `read:tenant_operations` read every tenant's operations.

Closes #1720.
