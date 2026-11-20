---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
---

Add Self-Service SSO storage (#1763): self-service profiles (with their custom text) and SSO access tickets.

- New optional adapters `selfServiceProfiles` and `ssoAccessTickets`, implemented by the drizzle and kysely adapters.
- Custom text is a JSON column of the profile (language → page → texts), so it needs no table of its own and goes with the profile.
- SSO access tickets are stored by a hash of the ticket id only; the ticket id itself (the bearer value in the ticket URL) is never stored.
- Deleting a profile also deletes its tickets, atomically. In drizzle, deleting a tenant also deletes its profiles and tickets (cascading foreign keys, like the other drizzle tables).
- A profile's stored `allowed_strategies` read back fail-closed: an unknown entry is dropped on its own, and an unreadable value reads as `[]` (nothing allowed). Only a profile that never set the field reads it as absent.
- A self-service connection's email domains stay on the connection (`connections.self_service`, added in the previous release); there is no separate domains table.

Migrations: drizzle `0022_self_service_sso` and kysely `2026-11-20T12:00:00_self_service_sso` create two new tables (`self_service_profiles`, `sso_access_tickets`). They only add tables, so they are safe to run before deploying the new code.
