---
"@authhero/adapter-interfaces": minor
"authhero": minor
"@authhero/multi-tenancy": minor
"@authhero/admin": patch
---

Hide the inheritance controls on tenants that have nothing below them. The tenant settings (`GET`/`PATCH /api/v2/tenants/settings`) carry a computed `has_children` (and, from the multi-tenancy router, `is_control_plane`). The admin hides the _Publishing_ card on a tenant without child tenants, the _Rollouts_ button when the control plane has none, the _Source_ column of connections, hooks and resource servers on a tenant that has no children, no parent and is not synced, and the _Parent_ and _Config sync_ columns of the tenants list until a tenant has a parent or is synced. It keeps showing them while the answer is loading or when the server does not send it.
