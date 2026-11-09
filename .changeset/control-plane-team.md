---
"create-authhero": minor
---

The `cloudflare-control-plane` template now serves the admin's Team page (`tenantMembers` with `createLocalTenantMembersBackend`). A tenant's team is an organization on the control plane named like the tenant, so the control plane answers `/tenant-members` from its own database. Without it the call was forwarded to the tenant's Worker, which cannot answer it, and the page showed "Unable to load the team for this tenant".
