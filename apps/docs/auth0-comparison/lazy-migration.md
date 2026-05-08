---
title: Lazy Migration from Auth0
description: Migrate users from Auth0 to AuthHero gradually, without forcing a password reset and without re-authenticating active sessions.
---

# Lazy Migration from Auth0

Move traffic from an Auth0 tenant to AuthHero one user at a time, without forcing every user to reset their password or re-authenticate. Two flows handle the long tail:

1. **Password fallback** — on a password login, if no local hash matches, AuthHero verifies the password against the upstream Auth0 (Resource Owner Password Realm grant), fetches the user's profile from `/userinfo`, creates the user locally, and stores the hash. Subsequent logins are served entirely by AuthHero.
2. **Refresh-token proxy** — Auth0 refresh tokens are opaque server-side handles, so they can't be re-issued by AuthHero. Instead, refresh-token requests that don't match a local row are forwarded to upstream Auth0 verbatim. Existing Auth0 sessions keep working until the user does an interactive login (where the password fallback migrates them).

Bulk import via `/api/v2/users-imports` and the [Auth0 proxy app](/apps/auth0-proxy/) remain useful for other migration shapes; this page covers the lazy/just-in-time approach that needs no client SDK changes.

## What you need from Auth0

A regular Auth0 application (typically your existing one) with these settings:

- **Grant Types**: enable `Password` and the extension grant `http://auth0.com/oauth/grant-type/password-realm` under Application → Settings → Advanced → Grant Types.
- **Client ID and Client Secret** of that application — AuthHero uses them to call upstream `/oauth/token` for both password-realm grants and refresh-token grants.
- The Auth0 **Domain** (e.g. `example.auth0.com`).

No Management API M2M token is required for v1 — `/userinfo` is called with the access_token returned by the password-realm grant.

## Configuration

Configure the upstream connection through the standard `connections` API/admin UI — no new endpoints, no new tenant fields.

### 1. Create the upstream-source connection

Add a connection with strategy `auth0`. This connection is metadata only; users never authenticate against it directly (it is filtered out of the universal-login button list).

In the **react-admin admin UI**:

1. Connections → New connection
2. Strategy → **Auth0 (migration source)**
3. Open the new connection and fill in:
   - **Token Endpoint** — `https://<your-tenant>.auth0.com/oauth/token`
   - **Userinfo Endpoint** — `https://<your-tenant>.auth0.com/userinfo`
   - **Client ID** / **Client Secret** — from the Auth0 application above
   - **Proxy Refresh Tokens** — enable to forward unknown refresh tokens to upstream Auth0

Or via the Management API:

```http
POST /api/v2/connections
Content-Type: application/json

{
  "name": "auth0-source",
  "strategy": "auth0",
  "options": {
    "token_endpoint": "https://example.auth0.com/oauth/token",
    "userinfo_endpoint": "https://example.auth0.com/userinfo",
    "client_id": "<auth0-client-id>",
    "client_secret": "<auth0-client-secret>",
    "import_mode": true
  }
}
```

A tenant is expected to have at most one `strategy: "auth0"` connection. The `import_mode` flag on this connection controls **refresh-token proxying** specifically.

### 2. Enable lazy import on the database connection

To let password logins fall back to upstream Auth0, set `import_mode: true` on the DB connection (typically `Username-Password-Authentication`):

In the admin UI: edit the connection and toggle **Import Mode** ("On unknown passwords, fall back to upstream Auth0…").

Or via the Management API:

```http
PATCH /api/v2/connections/<db-connection-id>
Content-Type: application/json

{
  "options": { "import_mode": true }
}
```

`import_mode` here is the same flag Auth0 uses on its own Custom Database connections — same name, symmetric semantics. AuthHero's password flow will:

1. Try the local password hash first.
2. On miss, look up the tenant's `strategy: "auth0"` connection for upstream credentials.
3. Call `POST /oauth/token` with `grant_type=http://auth0.com/oauth/grant-type/password-realm`, `realm=<DB connection name>`, the supplied username/password, and the upstream client credentials.
4. On 200, fetch the profile from `/userinfo` and create the local user (if missing) + bcrypt hash.
5. On any upstream error, surface the existing `INVALID_PASSWORD` rejection so the upstream's existence is not leaked.

## What happens during a typical migration

| Day | Event | What runs |
| --- | --- | --- |
| 0 | DNS flipped, AuthHero is now serving auth | Local lookups miss; password/RT fallback activates |
| 0–N | Active users open the app | RT proxy forwards their refresh requests to Auth0; they keep their session |
| 0–N | A user signs in with username/password | Password fallback verifies against Auth0, creates them locally, stores hash |
| N+1 | Migrated user signs in again | Served entirely from AuthHero — no upstream call |
| Eventually | Last Auth0 session expires | RT proxy traffic drops to zero |

Once the upstream traffic drops to a handful per day you can flip `import_mode` off and decommission the upstream Auth0 tenant.

## Edge cases and gotchas

- **MFA-enforced users**: Auth0 returns `mfa_required` from the password-realm grant. AuthHero treats it as a generic `INVALID_PASSWORD` to avoid leaking that the user exists upstream — affected users must reset on the AuthHero side.
- **`unauthorized_client: Grant type … not allowed`**: the Auth0 application has not been granted the password-realm grant. Enable it under Application → Advanced → Grant Types.
- **Failed-login throttling still applies**: the existing 3-strikes lockout fires whether the password compare runs locally or against upstream, so an attacker can't bypass it by forcing the upstream path.
- **Refresh-token rotation**: when the Auth0 tenant has rotation enabled, the proxied response contains a new refresh token; AuthHero relays it to the client unchanged. AuthHero does not persist upstream refresh tokens.
- **Connection name === realm**: AuthHero sends the local DB connection's name as the upstream `realm`. Keep the DB connection's name aligned with the upstream connection name (typically `Username-Password-Authentication`).
- **Connection visibility**: the `strategy: "auth0"` connection is automatically hidden from the universal-login button list — it's a metadata holder, not an interactive auth path.

## Comparison with the other migration mechanisms

- **[Auth0 proxy app](/apps/auth0-proxy/)** — a thin reverse proxy that exposes an Auth0-shaped surface to legacy clients during the cutover. Use when clients can't be repointed to AuthHero yet.
- **[Token Exchange (RFC 8693)](https://github.com/markusahlstrand/authhero/issues/807)** — proposed: lets clients explicitly swap a long-lived Auth0 refresh token for a native AuthHero refresh token. Cleaner end state but requires an SDK change.
- **Lazy migration (this page)** — no client changes; suitable when you cannot or do not want to update apps. Refresh tokens stay proxied until the user re-logs in.

These are complementary — most production migrations use lazy migration as the foundation and add the Auth0 proxy app for the small number of clients that need an Auth0-shaped HTTP surface.
