---
"@authhero/multi-tenancy": minor
"@authhero/adapter-interfaces": minor
---

Add the parent-chain resolver for tenant config inheritance and a shadow mode. `resolveTenantChain` and `mergeConfig` merge a tenant's ancestors (nearest wins, hooks and actions add up, secrets layered, `override` respected). With `inheritanceShadow` enabled on `initMultiTenant` or `createRuntimeFallbackAdapter`, reads start a background comparison against read-time inheritance and log differences as log type `cfgdiff`, queryable per tenant. The result is never used to serve requests.
