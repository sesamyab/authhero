---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
---

Add Self-Service SSO storage (#1763): self-service profiles with their custom text, SSO access tickets and connection domains.

- New optional adapters `selfServiceProfiles`, `ssoAccessTickets` and `connectionDomains`, implemented by the drizzle and kysely adapters.
- SSO access tickets are stored by a hash of the ticket id only; the ticket id itself (the bearer value in the ticket URL) is never stored.
- Deleting a profile also deletes its custom text and tickets.
- Connection domains hold the DNS verification state (TXT record value, `pending`/`verified`). Several connections may hold a pending claim on the same domain.

Migrations: drizzle `0022_self_service_sso` and kysely `2026-11-20T12:00:00_self_service_sso` create four new tables (`self_service_profiles`, `self_service_profile_custom_texts`, `sso_access_tickets`, `connection_domains`). They only add tables, so they are safe to run before deploying the new code.
