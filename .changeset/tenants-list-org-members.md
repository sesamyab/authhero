---
"@authhero/multi-tenancy": patch
---

Fix `GET /api/v2/tenants` returning 403 for users who only have organization membership (no `read:tenants` or `auth:read` scope). The route now requires authentication only; the handler filters by control-plane organization membership and returns an empty list when the user has no accessible tenants.
