---
"@authhero/cloudflare-adapter": patch
---

A tenant Worker built with `createWfpTenantApp` now refuses a control plane token that is scoped to another tenant's organization. The token's `org_name` must be the Worker's `TENANT_ID`; a Worker without one refuses organization-scoped tokens, since the request's own tenant is not something to trust; a token with an organization id but no name is refused, and a control plane token with no organization (an operator, or a machine client) still passes. The check is added after `configure`, so a host that replaces `managementApiMiddleware` cannot drop it.
