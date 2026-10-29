---
"authhero": patch
---

With `tenantDispatch` and `tenantMembers` both set, `/tenant-members` is served by the control plane instead of being forwarded to the tenant's worker. The team is a control-plane organization the tenant's database does not hold, so a forwarded worker had to call back up to the control plane's own hostname. Where that same-zone call never arrives, every Team page request answered 404 "The member does not exist" (#1632). A tenant worker has no `tenantDispatch`, so its calls are unchanged.
