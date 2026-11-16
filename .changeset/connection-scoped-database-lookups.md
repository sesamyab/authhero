---
"authhero": patch
---

Scope database-user lookups by connection. Every database connection stores its users under the `auth0` provider, so password login, password reset, `/dbconnections`, invitations and the ticket flow could match a user that belongs to another database connection of the tenant. These lookups now take the connection they target and skip users of the tenant's other database connections, preferring a row in the connection itself over a legacy row that can't be attributed to one. Tenants with a single database connection get the same lookups as before, as do rows whose `connection` doesn't name one of the tenant's database connections.

New database users created by `/dbconnections/signup`, a password-reset request, an accepted invitation and the ticket flow now store the client's database connection name, like the universal-login signup already did, instead of the `Username-Password-Authentication` literal. Signup duplicate checks stay unscoped until the unique index moves to connections, so a signup for an address used in another database connection still answers like an existing user.
