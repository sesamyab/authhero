---
"authhero": patch
---

Gate the DCR consent tenant picker (`/u2/connect/select-tenant`) by Management API permission instead of bare org membership. The picker now only lists a child tenant when the consenting user holds `create:clients` on `urn:authhero:management` via a role scoped to that tenant's control-plane org. The control plane itself is never offered as a registration target, even if the user is a member of its self-org. Users with a global (non-org-scoped) role granting `admin:organizations` continue to bypass the membership check, mirroring `@authhero/multi-tenancy`'s provisioning escape hatch.
