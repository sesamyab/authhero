---
"authhero": minor
"@authhero/adapter-interfaces": patch
---

Team changes can be registered as requests (issue #1550). With `tenantMembers.requests` set, the write routes of `/api/v2/tenant-members` store the change as a request on the shard and answer `202`, `GET /api/v2/tenant-members/requests` lists them, and `createControlPlaneRequestNotifier` tells the control plane that one is waiting. The control-plane `tenant-members` resource gets `POST /requests/notify` (`requests.onNotify`), and `executeTenantMemberRequest` carries a request out against the tenant's team after checking the tenant and that the requester is still an administrator. Without the option the routes behave as before. Adds the `add_members` request kind.
