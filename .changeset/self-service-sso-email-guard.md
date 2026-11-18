---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
"authhero": minor
---

Self-Service SSO (#1763), account-linking guard. Connections get an internal `self_service` field (a new nullable `self_service` column; run the drizzle and kysely migrations) recording that a connection is set up through Self-Service SSO and which email domains are verified for it. It is not part of the Auth0 connection object: the Management API neither accepts nor returns it, and tenant export, import and config sync do not copy it.

For a self-service connection, an email is only trusted inside its verified domains. Outside verified domains, new users are stored with `email_verified: false`. When root attributes sync on every login, the guard also clears a previously stored `true`. Built-in linking, the `account-linking` template hook and code hooks' `link_candidates` exclude users whose email domain is unverified for their self-service connection. This keeps an identity provider configured by an outside admin from taking over existing accounts or capturing accounts created later with the same email. Ordinary connections are unchanged.
