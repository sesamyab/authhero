---
title: Developer App Invites
description: Let an outside developer register and update their own OAuth app in your tenant through time-limited links, without an account.
---

# Developer App Invites

An outside developer, for example an agency building a native app for one of your customers, can register their own application (OAuth/OIDC client) in a tenant and update it later. You send them a link instead of collecting redirect URLs by email. The developer never gets an account: the link is their only credential, and it is time-limited.

The feature is built on standard [RFC 7591](/standards/rfc-7591) Initial Access Tokens and [RFC 7592](/standards/rfc-7592) management. Auth0 has no equivalent; the naming (`registration-ticket`, `POST …/revoke`) follows Auth0's ticket endpoints.

## How it works

1. **Invite.** In the admin UI, open **Applications** and choose **Invite a developer**. Pick the app type, say who the invite is for and how long the link lasts (7 days by default, at most 30). Optionally pin the login methods the app may use, and whether users see a consent screen. Copy the link; it is shown once.
2. **Register.** The developer opens the link. A page with your tenant's branding asks for the app name, callback URLs, logout URLs, allowed web origins (browser apps), a logo URL, and optional website, privacy policy, terms and contact email. Submitting creates the app and shows the **Client ID**, the domain and the discovery URL. A regular web app also gets its **client secret**, shown once. The invite is used up.
3. **Update.** When the developer needs a change, open the app in the admin UI, go to **Developer Access** and choose **Generate edit link** (7 days, or 30 with _Keep active for 30 days_). The link opens the same page, pre-filled. The developer can change the name, logo, URLs and contact details, and nothing else. A new edit link replaces the app's previous ones.
4. **Revoke.** Invites are listed under **Applications → App invites** with their status (active, used, expired, revoked). Edit links and registration access tokens are listed on the app's **Developer Access** tab. Revoking takes effect on the next request, including on a page the developer already has open.

Edit links also work for apps you created by hand.

## App types

Each invite pins an app type. The restrictions hold whether the developer uses the page or calls `POST /oidc/register` with the token.

|                       | Native                                                                            | Single-page            | Regular web            |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------- | ---------------------- |
| Grant types           | `authorization_code`, `refresh_token`                                             | same                   | same                   |
| Client authentication | none (public client)                                                              | none (public client)   | `client_secret_post`   |
| PKCE                  | S256 required                                                                     | S256 required          | S256 required          |
| Callback URLs         | https, a custom scheme with a dot (`com.example.app:/callback`), or loopback http | https or loopback http | https or loopback http |
| Web origins           | not used                                                                          | origins only           | origins only           |

Every URL: no wildcards, no fragments, no user names or passwords, at most 1024 characters and 20 entries per list. Loopback http means `localhost`, `127.0.0.1` or `[::1]` with any port, for local development.

Invite-created apps never get API access through client grants. Users sign in to them the same way they sign in to your own apps: first-party (no consent screen) unless the invite says otherwise.

**Login methods.** By default the app uses all of the tenant's login methods, including ones added later. Choose specific login methods in the invite to pin them.

**Logo.** Through a link the logo can be replaced, not removed.

## Management API

| Method | Path                                             | Scope                               |                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v2/client-registration-tokens`             | `create:client_registration_tokens` | With `preset` (`native`, `spa`, `regular_web`) and `name`: a developer invite. Optional `connections`, `is_first_party`, `expires_in_seconds` (default 7 days with a preset, at most 30 days). Returns `ticket`, the setup link. |
| GET    | `/api/v2/client-registration-tokens`             | `read:client_registration_tokens`   | List, newest first. Filters: `type`, `source` (`invite`, `edit_link`, `registration`, `connect`), `client_id`. Each row has a `status`. Tokens are never returned.                                                               |
| GET    | `/api/v2/client-registration-tokens/{id}`        | `read:client_registration_tokens`   | One row. A used invite carries the `client_id` it created.                                                                                                                                                                       |
| POST   | `/api/v2/client-registration-tokens/{id}/revoke` | `delete:client_registration_tokens` | Returns `202`. The row is kept.                                                                                                                                                                                                  |
| POST   | `/api/v2/clients/{id}/registration-ticket`       | `create:client_registration_tokens` | Edit link. Body `{ "ttl_sec": 604800 }` (at most 30 days). Returns `{ id, ticket, expires_at }` and revokes the client's previous edit links.                                                                                    |

```bash
curl -X POST "https://auth.example.com/api/v2/client-registration-tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "preset": "native", "name": "Agency iOS app" }'
```

Deleting a client through the Management API revokes its edit links and registration access tokens.

## For the developer: using the API instead of the page

The token in an invite link (the `ticket` query parameter) is an RFC 7591 Initial Access Token, and the token in an edit link is an RFC 7592 Registration Access Token:

- `POST /oidc/register` with `Authorization: Bearer <invite token>` registers the app. It requires dynamic client registration to be enabled on the tenant; the setup page does not.
- `GET`/`PUT /oidc/register/{client_id}` with `Authorization: Bearer <edit link token>` reads or updates it, limited to the same fields as the page. `DELETE` is refused (`405`): the operator owns the app's lifecycle.

Besides the RFC 7591 fields, registration accepts `application_type` and `post_logout_redirect_uris` (OpenID Connect) and `web_origins`.

## Security notes

- Links carry a 256-bit random token, stored only as a hash. The first request moves the token out of the address bar (redirect with `Referrer-Policy: no-referrer`), and ticket values are redacted from logs.
- One generic page answers an unknown, expired, used or revoked link.
- Every request on the page re-checks the link.
- A link only works on the tenant it was issued for.
- Registration, updates and rejected links are logged (`sapi` / `fapi`).
