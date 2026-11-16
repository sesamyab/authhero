---
"authhero": patch
"@authhero/adapter-interfaces": patch
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"@authhero/aws-adapter": patch
---

Fix CIMD logins resuming in the wrong tenant when several tenants have a stub client for the same client_id URL (#1731). The state-keyed routes (`/callback`, `/authorize/resume` and the universal login screens) now take the tenant from the login session row instead of from a lookup by client_id alone. `LoginSession` exposes an optional `tenant_id`, which the kysely, drizzle and AWS adapters set on read. `clients.getByClientId` returns null for a URL client_id that has rows in more than one tenant, so `getEnrichedClient` no longer picks one of them: it uses the stub only when exactly one tenant has it, and otherwise throws the existing 400 "tenant_id is required to resolve a CIMD client". Host-scoped routes that take the client_id from the request (`/co/authenticate`, `/passwordless/*`, `/dbconnections/*`, `/v2/logout`, `/oidc/logout`, `/account`, SMS sending, u2 invitations and password-change tickets) pass the request's tenant for CIMD client_ids.
