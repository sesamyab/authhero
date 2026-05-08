---
"authhero": patch
---

Match Auth0 on `GET /api/v2/emails/provider`: when no email provider is configured for the tenant, return 200 with an empty JSON object (`{}`) instead of 404. SDKs and admin UIs that follow Auth0 semantics no longer need to special-case authhero's 404 to render an empty edit form.
