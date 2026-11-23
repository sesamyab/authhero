---
"authhero": patch
---

Database connection selection (#1703) follow-ups:

- A password reset stores the database connection it targets on its login session, so both completion screens look in the same connection even if the client's connection list changes in between.
- `/authorize` with `connection=Username-Password-Authentication` uses the client's default database connection when no enabled connection has that exact name, instead of treating it as an external connection.
- Connection-scoped user lookups read every page of the tenant's connections, not only the adapter's first page.
- A login ticket records the user whose password `/co/authenticate` verified, and `/authorize` logs in that user (its primary) instead of looking the username up again.
- The connection a login ticket may be redeemed in is recorded in the login session's `state_data` (`ticket_connection`), which only the password branch of `/co/authenticate` writes. `authParams.connection`, which `/authorize` and `/dbconnections` set from the request, no longer counts for tickets.
- The oldest-first order for clients without an explicit connection list compares `created_at` as instants, so offset timestamps sort correctly.
