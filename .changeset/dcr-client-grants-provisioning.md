---
"authhero": minor
---

Provision a `client_grants` row alongside the client when `audience` (and optionally `scope`) are passed to `POST /oidc/register`. The DCR endpoint now accepts an `audience` field (RFC 7591 extension), validates it against the tenant's resource servers, validates each scope is defined on that resource server, and creates the grant inside the same transaction as the client. `DELETE /oidc/register/:client_id` removes the client's grants alongside the soft-delete.

The `/connect/start` consent flow accepts the same `audience` query param, validates it up front, surfaces the resource server's name on the consent screen ("For API: <name>"), and pre-binds `audience` into the IAT constraints so a user-initiated DCR call cannot widen what was consented to. This makes a fully self-service M2M client registration possible: the user clicks Connect → DCR creates client + grant → `client_credentials` at `/oauth/token` mints an access token with the granted scopes.

`scope` without `audience` is now rejected at both `/connect/start` and `POST /oidc/register` (previously the scope round-tripped as metadata but produced no working permissions).
