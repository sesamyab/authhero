---
"authhero": minor
"@authhero/multi-tenancy": minor
---

`PATCH /tenants/{id}` changes a tenant's `config_sync` mode and parent on the control plane, by id. It is for control-plane callers only (organization-scoped tokens get `403`) and writes only the fields the body names. Until now the mode could only be changed through `PATCH /tenants/settings`, which acts on the tenant named by the request.

With `tenantDispatch`, a request for a tenant that runs in its own worker is forwarded to that worker, and `/tenants/settings` is the tenant's own and still is. The control plane's tenant records (the list, `/tenants/{id}`, config-sync status, operations) are not in the tenant's database, so `ManagementApiExtension` has a new `controlPlane` flag, which `@authhero/multi-tenancy` sets on `/tenants`: those requests are now served by the control plane even when the `tenant-id` header names a `wfp` tenant. Both packages are needed for this: with an older `authhero`, the flag is ignored and the request is still forwarded.
