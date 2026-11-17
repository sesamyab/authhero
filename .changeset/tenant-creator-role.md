---
"@authhero/multi-tenancy": minor
---

Fix the creator of a new tenant getting no role in it when the host uses `initMultiTenant`, and stop giving self-service creators every management scope.

- `initMultiTenant` now creates the "Tenant Admin" role and assigns it to the creator in the tenant's organization. It was only created when `accessControl.issuer` was set, and `initMultiTenant` never set it, so the creator became a member of the organization with no role. `setupMultiTenancy` keeps its rule; set `accessControl.provisionRoles: true` to opt in there.
- An existing role is topped up on the next tenant creation with scopes added to the Management API since it was created (permissions an operator added are kept), instead of being returned as it was.
- New "Tenant Owner" role (`ownerRoleName`): every management scope except `create:tenants`, `delete:tenants`, `admin:organizations`, `access:all_organizations`, the rollout scopes and the tenant-operation scopes. A creator gets Tenant Admin only if they already hold the operator scopes globally (`create:tenants`, `delete:tenants`, the rollout scopes and the tenant-operation scopes), so the role in the organization never grants more than they had; everyone else gets Tenant Owner, including a self-service creator and a creator who has only `create:tenants`. This changes what a creator who does not hold those scopes gets compared to before, when everyone got Tenant Admin (on the `issuer` path). Existing creators keep the role they have.
- A test freezes the owner role's scope list, so a newly added management scope has to be placed on purpose.

Closes #1719.
