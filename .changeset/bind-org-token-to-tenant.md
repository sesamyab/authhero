---
"authhero": minor
---

Bind an organization-scoped control-plane token to the tenant its organization names. Such a token carries the permissions of that organization's roles, and on the control plane an organization is a tenant, but the management API let it act on any tenant by naming it in `tenant-id`, including the control plane itself. A member of one tenant's organization who held a role with `update:users` or `update:roles` could change the control plane's users and roles and make themselves an operator, and any Tenant Admin could manage other tenants' users and clients.

The management API now answers `403` when the token's tenant is the control plane, the token carries an organization (`org_name`, or `org_id`, resolved to the organization's name on the control plane) and the request's tenant is not that tenant. The match ignores case. An `org_id` that names no organization is refused, and a failing organization lookup is a `500`.

The tenants router in the control plane's own context stays reachable (`/tenants`, `/tenants/{id}` and what hangs off it), since it checks access per organization itself. `/tenants/settings` is not exempt: it acts on the tenant the request is in. Tokens without an organization claim, and tokens issued by a child tenant, are not affected. A caller who needs to work on the control plane or across tenants has to use a token that is not scoped to an organization.
