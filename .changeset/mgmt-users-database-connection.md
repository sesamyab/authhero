---
"authhero": patch
---

Management API users are created and updated within their database connection. `POST /api/v2/users` accepts the connection's name or id, stores the name on a database user, and checks email and username against that connection, answering a duplicate with Auth0's `409 The user already exists.` body (a duplicate caught by the unique index used to return a bare `User already exists`). `PATCH /api/v2/users/{id}` checks a username change within the user's connection (a taken username used to fail with a 500), treats legacy rows the login lookups see as part of the same connection when checking an email change, and accepts any database connection's name in `connection` to target the identity or set its password.
