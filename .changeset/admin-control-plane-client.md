---
"@authhero/admin": patch
---

A tenant's config sync mode and parent are read and saved with a token that has no organization. They were sent with the token scoped to the tenant's organization, which the control plane refuses for those two settings (`403 Only the control plane can change a tenant's config_sync mode or parent`), so an operator could not change them from a tenant's settings. A tenant's own admin is still refused, as intended. With tenant subdomains the calls are also sent to the control plane's own host and not to the tenant's subdomain. The admin's own HTTP client now keeps the response status on a failed call (as `httpStatus`, not `status`, so react-admin does not sign the user out on a 403), which is how a control plane without `PATCH /tenants/{id}` (404 or 405) is told from a refusal and the old save is used.
