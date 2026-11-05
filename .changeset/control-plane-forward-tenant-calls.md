---
"create-authhero": minor
---

The `cloudflare-control-plane` template now forwards tenant-scoped management calls for a ready `wfp` tenant to that tenant's own Worker (`tenantDispatch` with `createWfpForwardMiddleware`). An admin UI that signs in on the control plane and names a tenant with the `tenant-id` header now reaches the tenant's database; before, the control plane answered from its own database, where a WFP tenant has no data.
