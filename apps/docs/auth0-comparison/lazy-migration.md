---
title: Lazy Migration from Auth0
description: Migrate users from Auth0 to AuthHero gradually, without forcing a password reset and without re-authenticating active sessions.
---

# Lazy Migration from Auth0

Move traffic from an Auth0 tenant to AuthHero one user at a time, without forcing every user to reset their password or re-authenticate the next time they interactively sign in.

**Password fallback** — on a password login, if no local hash matches, AuthHero verifies the password against the upstream Auth0 (Resource Owner Password Realm grant), fetches the user's profile from `/userinfo`, creates the user locally, and stores the hash. Subsequent logins are served entirely by AuthHero.

> **Refresh tokens issued by upstream Auth0 are no longer accepted.** Earlier versions forwarded unknown refresh-token requests to Auth0 verbatim; that proxy was removed when the `strategy: "auth0"` source connection was collapsed into the DB connection. Clients presenting a refresh token AuthHero did not mint now receive `invalid_grant` ("Invalid refresh token") and must re-authenticate interactively. Re-mint of upstream tokens is tracked in [issue #833](https://github.com/markusahlstrand/authhero/issues/833).

Bulk import via `/api/v2/users-imports` and the [Auth0 proxy app](/apps/auth0-proxy/) remain useful for other migration shapes; this page covers the lazy/just-in-time approach that needs no client SDK changes.

## Migrating from a version that proxied refresh tokens

If you are upgrading from a release that forwarded refresh tokens upstream, plan the cutover with the refresh-token break in mind:

- **Client impact**: every active client still holding an Auth0-issued refresh token will get `invalid_grant` on its next exchange and must run its normal interactive-login fallback. Browser SPAs typically recover on the next page load; long-lived native clients (mobile/desktop) recover at the next foreground.
- **Proactive migration is not currently possible**: AuthHero cannot re-mint a native refresh token from an opaque Auth0 handle without the user re-authenticating. Until [#833](https://github.com/markusahlstrand/authhero/issues/833) lands there is no server-side migration path for refresh tokens — only password fallback at the next interactive login.
- **Recommended timing**: deploy the cutover at a low-traffic window and watch the `FAILED_EXCHANGE_REFRESH_TOKEN_FOR_ACCESS_TOKEN` log type to confirm the spike subsides as users complete interactive logins. There is no built-in grace period; if you need one, keep the previous release running side-by-side behind the [Auth0 proxy app](/apps/auth0-proxy/) for the clients you cannot re-prompt.

## What you need from Auth0

A regular Auth0 application (typically your existing one) with these settings:

- **Grant Types**: enable `Password` and the extension grant `http://auth0.com/oauth/grant-type/password-realm` under Application → Settings → Advanced → Grant Types.
- **Client ID and Client Secret** of that application — AuthHero uses them to call upstream `/oauth/token` for both password-realm grants and refresh-token grants.
- The Auth0 **Domain** (e.g. `example.auth0.com`).

No Management API M2M token is required for v1 — `/userinfo` is called with the access_token returned by the password-realm grant.

## Configuration

Configure the upstream credentials directly on the DB connection — no separate source connection, no new endpoints, no new tenant fields.

### Enable lazy import on the database connection

The upstream Auth0 credentials live on the same DB connection users land on (typically `Username-Password-Authentication`), under `options.configuration`. Setting `options.import_mode: true` enables the password fallback:

In the admin UI: edit the connection and toggle **Import Mode** ("On unknown passwords, fall back to upstream Auth0…"), then fill in the upstream **Token Endpoint**, **Userinfo Endpoint**, **Client ID**, and **Client Secret**.

Or via the Management API:

```http
PATCH /api/v2/connections/<db-connection-id>
Content-Type: application/json

{
  "options": {
    "import_mode": true,
    "configuration": {
      "token_endpoint": "https://example.auth0.com/oauth/token",
      "userinfo_endpoint": "https://example.auth0.com/userinfo",
      "client_id": "<auth0-client-id>",
      "client_secret": "<auth0-client-secret>"
    }
  }
}
```

`import_mode` here is the same flag Auth0 uses on its own Custom Database connections — same name, symmetric semantics. AuthHero's password flow will:

1. Try the local password hash first.
2. On miss, read the upstream credentials from this connection's `options.configuration`.
3. Call `POST /oauth/token` with `grant_type=http://auth0.com/oauth/grant-type/password-realm`, `realm=<DB connection name>`, the supplied username/password, and the upstream client credentials.
4. On 200, fetch the profile from `/userinfo` and create the local user (if missing) + bcrypt hash.
5. On any upstream error, surface the existing `INVALID_PASSWORD` rejection so the upstream's existence is not leaked.

## What happens during a typical migration

| Day | Event | What runs |
| --- | --- | --- |
| 0 | DNS flipped, AuthHero is now serving auth | Local lookups miss; password fallback activates |
| 0 | Clients holding Auth0 refresh tokens hit `/oauth/token` | AuthHero returns `invalid_grant`; clients fall back to interactive login |
| 0–N | A user signs in with username/password | Password fallback verifies against Auth0, creates them locally, stores hash |
| N+1 | Migrated user signs in again | Served entirely from AuthHero — no upstream call |
| Eventually | All long-tail clients have re-authenticated | `FAILED_EXCHANGE_REFRESH_TOKEN_FOR_ACCESS_TOKEN` log volume settles |

Once the upstream password-fallback traffic drops to a handful per day you can flip `import_mode` off and decommission the upstream Auth0 tenant.

## Edge cases and gotchas

- **MFA-enforced users**: Auth0 returns `mfa_required` from the password-realm grant. AuthHero treats it as a generic `INVALID_PASSWORD` to avoid leaking that the user exists upstream — affected users must reset on the AuthHero side.
- **`unauthorized_client: Grant type … not allowed`**: the Auth0 application has not been granted the password-realm grant. Enable it under Application → Advanced → Grant Types.
- **Failed-login throttling still applies**: the existing 3-strikes lockout fires whether the password compare runs locally or against upstream, so an attacker can't bypass it by forcing the upstream path.
- **Refresh tokens issued by Auth0 are not honored**: see the note above and [#833](https://github.com/markusahlstrand/authhero/issues/833). Clients must reauthenticate to receive an AuthHero-minted refresh token.
- **Connection name === realm**: AuthHero sends the local DB connection's name as the upstream `realm`. Keep the DB connection's name aligned with the upstream connection name (typically `Username-Password-Authentication`).

## Comparison with the other migration mechanisms

- **[Auth0 proxy app](/apps/auth0-proxy/)** — a thin reverse proxy that exposes an Auth0-shaped surface to legacy clients during the cutover. Use when clients can't be repointed to AuthHero yet, or to keep refresh tokens working for long-tail clients while you wait for them to re-authenticate.
- **[Token Exchange (RFC 8693)](https://github.com/markusahlstrand/authhero/issues/807)** and **[refresh-token re-mint](https://github.com/markusahlstrand/authhero/issues/833)** — proposed: server-side paths that would let AuthHero translate an upstream Auth0 refresh token into a native AuthHero one. Neither has shipped; until they do, upstream refresh tokens are rejected.
- **Lazy migration (this page)** — no client changes for password logins; clients holding upstream refresh tokens must re-authenticate once.

These are complementary — most production migrations use lazy migration as the foundation and add the Auth0 proxy app for the small number of clients that need an Auth0-shaped HTTP surface or that cannot tolerate a forced re-authentication.
