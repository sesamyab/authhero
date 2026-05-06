---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"authhero": patch
---

Add `default_client_id` to the tenant schema. `/connect/start` now prefers this client as the login_session anchor for tenant-level DCR consent flows, falling back to the first available client so a brand-new tenant can still bootstrap its first integration. Roughly analogous to Auth0's "Default App" / Global Client.
