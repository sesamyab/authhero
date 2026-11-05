---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"authhero": patch
---

Store MFA completion on the browser session. Sessions get an optional `authentication.methods[]` field (Auth0's shape): each successful MFA challenge appends `{ name: "mfa", type, timestamp }`. SSO to another client on a session that completed MFA no longer asks for MFA again, and silent authentication (`prompt=none`) returns `interaction_required` when the tenant requires MFA but the session never completed it, for example a session from before MFA was enabled. Adds a nullable `sessions.authentication` column (kysely migration `2026-11-05T12:00:00_session_authentication`, drizzle `0017_session_authentication`).
