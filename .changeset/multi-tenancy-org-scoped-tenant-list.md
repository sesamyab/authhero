---
"@authhero/multi-tenancy": patch
---

Fix tenant-list authorization bypass for org-scoped tokens. `GET /tenants` previously returned every tenant whenever the caller's token carried `admin:organizations` or `auth:read`, but `admin:organizations` is also granted via org-scoped roles — so any organization admin received cross-tenant visibility. The full-access shortcut now only applies when the token has no `org_id` claim, and the route additionally requires the `read:tenants` or `auth:read` scope.
