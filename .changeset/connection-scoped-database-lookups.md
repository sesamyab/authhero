---
"authhero": patch
---

Scope database-user lookups by connection. Every database connection stores its users under the `auth0` provider, so password login, signup, password reset, `/dbconnections` and the ticket flow could match a user that belongs to another database connection of the tenant. These lookups now take the connection they target and skip users of the tenant's other database connections. Tenants with a single database connection are unchanged, as are rows whose `connection` doesn't name one of the tenant's database connections (for example the hardcoded `Username-Password-Authentication` on a tenant whose connection has another name).
