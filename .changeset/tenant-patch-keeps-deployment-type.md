---
"authhero": patch
"@authhero/multi-tenancy": patch
"@authhero/adapter-interfaces": patch
---

Fix `PATCH /api/v2/tenants/settings` resetting `deployment_type` to `shared` and `provisioning_state` to `ready` whenever the body omitted them. The PATCH body now applies only the keys present (new `tenantPatchSchema`); create defaults are unchanged.
