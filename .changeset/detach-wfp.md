---
"@authhero/multi-tenancy": minor
"@authhero/cloudflare-adapter": minor
---

Detach for tenants with their own database. `createDispatchDetach` (`@authhero/cloudflare-adapter/wfp`) pushes a `detach` to the tenant worker's new `/internal/detach` route, which converts (or with `clean` removes) the synced copies in the tenant's own database. The control plane checks that the tenant can be detached from its own row and marks it detached only when the worker reports a full success. The Workflows executor runs `detach` (`runDetachOperation`), and `detachTenantRows`, `assertDetachEligible`, `markTenantDetached` and `emptyDetachResult` are exported from `@authhero/multi-tenancy`. A `detach` run also drops the remembered sync mode of the instance that ran it.
