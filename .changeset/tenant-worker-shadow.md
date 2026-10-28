---
"@authhero/cloudflare-adapter": minor
"@authhero/multi-tenancy": patch
---

Run config inheritance shadow mode in a tenant worker. `createWfpTenantApp` takes `inheritanceShadow` (`true` or the usual options): after a request is answered, it compares what the projected control-plane rows give the tenant with what its parent chain resolves to, under `ctx.waitUntil` so the Worker keeps it alive, and logs the differences as `cfgdiff` in the tenant's own logs. The shadow reporter now returns the comparison it starts so a host can wait for it.
