---
"authhero": patch
---

With `tenantDispatch` set, the control-plane routes authhero mounts itself (`/tenant-members`, `/operations`, `/tenants/:id/operations` and `/rollouts`) are served by the control plane instead of being forwarded to the tenant's worker. The team is a control-plane organization the tenant's database does not hold, so a forwarded worker had to call back up to the control plane's own hostname. Where that same-zone call never arrives, every Team page request answered 404 "The member does not exist" (#1632). `/tenants/settings` is still forwarded. A tenant worker has no `tenantDispatch`, so its calls are unchanged.

The tenant-members adapter now treats only the control plane's plain-text `Not found` as a missing team. Any other 404 (an unmounted route, the zone's origin) is reported as a 502 with the status in the message instead of `inexistent_member`. `ControlPlaneResponse` gains an optional `text` with the raw body.
