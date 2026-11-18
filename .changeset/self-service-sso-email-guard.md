---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
"authhero": minor
---

Self-Service SSO (#1763), account-linking guard. Connections get an internal `self_service` field (a new nullable `self_service` column; run the drizzle and kysely migrations) recording that a connection is set up through Self-Service SSO and which email domains are verified for it. It is not part of the Auth0 connection object: the Management API neither accepts nor returns it, and tenant export, import and config sync do not copy it.

For a self-service connection, an email is only trusted inside its verified domains. Outside them, a login stores `email_verified: false` whatever the identity provider asserted (and clears a stored `true` on the next login), and the connection's users are never picked as an email-linking target by built-in linking, the `account-linking` template hook or code hooks' `link_candidates`. This keeps an identity provider configured by an outside admin from taking over existing accounts or capturing accounts created later with the same email. Ordinary connections are unchanged.
