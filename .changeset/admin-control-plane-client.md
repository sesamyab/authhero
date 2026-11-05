---
"@authhero/admin": patch
---

A tenant's config sync mode and parent are read and saved with a token that has no organization. They were sent with the token scoped to the tenant's organization, which the control plane refuses for those two settings (`403 Only the control plane can change a tenant's config_sync mode or parent`), so an operator could not change them from a tenant's settings. A tenant's own admin is still refused, as intended.
