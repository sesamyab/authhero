---
"authhero": minor
"@authhero/admin": patch
---

Outgoing email now uses the tenant's `sender_email` and `sender_name` when the email provider has no `default_from_address`, then the new optional `DEFAULT_SENDER_EMAIL` binding, and last `login@` followed by the hostname of `ISSUER` instead of the whole URL, which gave an invalid address such as `login@https://localhost:3000/`. Settings > General in the admin edits `sender_email` and `sender_name` and shows the tenant's `audience` read-only.
