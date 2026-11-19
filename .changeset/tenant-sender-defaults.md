---
"authhero": minor
"@authhero/admin": patch
"@authhero/adapter-interfaces": patch
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
---

Outgoing email now uses the tenant's `sender_email` and `sender_name` when the email provider has no `default_from_address`, then the new optional `DEFAULT_SENDER_EMAIL` binding, and last `login@` followed by the hostname of `ISSUER` instead of the whole URL, which gave an invalid address such as `login@https://localhost:3000/`. A sender name with punctuation is sent as a quoted display name. Settings > General in the admin edits `sender_email` and `sender_name` and shows the tenant's `audience` read-only. `sender_email` can now be cleared with `null` in a tenant update; the Kysely and Drizzle adapters store it as unset.
