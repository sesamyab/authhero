---
"@authhero/cloudflare-adapter": patch
---

A tenant Worker built with `createWfpTenantApp` now refuses a control plane token that is scoped to another tenant's organization. A member of one tenant holds a control plane token with `org_name` set to that tenant's id, the control plane does not check a call it forwards, and the core cross-tenant guard only asked whether the token came from the control plane. So a member of `acme` could send `tenant-id: bob` to `bob`'s Worker and read its users, or create a client and get its secret back. The token's `org_name` must now be the Worker's `TENANT_ID` (or, for a Worker provisioned without one, the tenant the request resolved to); a token with an organization id but no name is refused, and a control plane token with no organization (an operator, or a machine client such as CI's) still passes. The check is added after `configure`, so a host that replaces `managementApiMiddleware` cannot drop it.
