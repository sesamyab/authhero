---
"@authhero/multi-tenancy": minor
"@authhero/cloudflare-adapter": minor
---

The control plane carries out the team changes that tenants register as requests (issue #1550). `initMultiTenant({ tenantMemberRequests: { getBackend } })` adds the `tenant-members-request` tenant operation, which reads the request from the tenant, runs it against the tenant's team (checking the tenant and that the requester still belongs to it) and answers the request with the outcome. `memberRequests.enqueue` is what the notify endpoint calls, once per request however often it is told, and `memberRequests.reconcile` is the sweep for requests that were never run or whose run failed, which a tenant worker cannot do itself. `createDispatchTenantMemberRequestStore` and `POST /internal/tenant-member-requests` on the tenant worker reach requests in a tenant's own database.
