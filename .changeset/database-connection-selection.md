---
"authhero": minor
---

Choose the database connection for password login, signup and password reset the way Auth0 does when an application enables several (#1703):

- A connection the request names is used when the application enables it: `/authorize` `connection` (carried on the login session for universal login), the password-realm `realm` on `/co/authenticate` and the login-ticket flow, and the `connection` field of `/dbconnections/signup` and `/dbconnections/change_password`. These no longer accept only `Username-Password-Authentication`. A name the application doesn't enable is rejected (`/authorize` 403, the others `400 invalid_request`).
- Otherwise the application's first enabled database connection is used. An application with no connections enabled uses the tenant's oldest database connection, and `GET /api/v2/clients/{id}/connections` lists its database connections in that order.
- The choice is made in one place, `resolveClientDatabaseConnection` in `helpers/database-connection-scope.ts`, which every password flow uses. The "Multiple username-password connections configured for this client" error is gone.
- A login ticket from `/co/authenticate` is bound to the database connection its password was checked in: `/co/authenticate` records the connection on the ticket's login session, and redeeming the ticket at `/authorize` with a `realm` that resolves to another connection, or with `realm=email`, is refused with `403 Invalid realm`.
- `PATCH /api/v2/connections/{id}/clients` applies repeated entries for one client in request order.
