---
title: Session Transfer
description: Carry a signed-in user from one application to another without a second login, including between websites on different top-level domains, using single-use session transfer tokens.
---

# Session Transfer

Session transfer carries a signed-in user from one application to another in the same tenant without a second login. It is compatible with [Auth0's Native to Web SSO](https://auth0.com/docs/authenticate/single-sign-on/native-to-web), and it also covers a case Auth0 does not: passing a session between websites on different top-level domains.

A typical case: a user is logged in on `app.acme.com` and follows a link to `shop.other.com`. Each site reaches AuthHero through its own domain, so the browser has no AuthHero session cookie on the second one and the user would be asked to log in again. With session transfer, the first site hands the second one a short-lived token, and the user arrives logged in.

```
sending app                          AuthHero                       receiving app
    │  POST /oauth/token                 │                                │
    │  refresh_token + audience ────────▶│                                │
    │◀──────── session_transfer_token ───│                                │
    │                                                                     │
    │  redirect the browser, token in the URL ───────────────────────────▶│
    │                                    │◀── GET /authorize              │
    │                                    │    ?session_transfer_token=…   │
    │                                    │─── code, no login prompt ─────▶│
```

The token is opaque, valid for 60 seconds, and works once. AuthHero stores only a hash of it.

## How it fits together

Two things have to be in place:

1. **The sending application may create tokens.** It sets `session_transfer.can_create_session_transfer_token`, and it holds a refresh token for the user, so the user logged in with the `offline_access` scope.
2. **The receiving application accepts tokens.** It lists at least one method in `session_transfer.allowed_authentication_methods`: `query`, `cookie` or both.

Both applications belong to the same tenant, and the user's connection must be enabled on the receiving application. One application can do both jobs.

In the admin UI these settings are on the **Session Transfer** tab of an application. Over the Management API they are the `session_transfer` object on the client:

```http
PATCH /api/v2/clients/{sending_client_id}
Content-Type: application/json

{
  "session_transfer": {
    "can_create_session_transfer_token": true
  }
}
```

```http
PATCH /api/v2/clients/{receiving_client_id}
Content-Type: application/json

{
  "session_transfer": {
    "allowed_authentication_methods": ["query"]
  }
}
```

A write merges into the stored object, so you only send the fields you want to change. The response then contains every field, with defaults filled in. A client that has never been configured returns `"session_transfer": {}`.

## Creating a token

The sending application exchanges its refresh token with the audience `urn:{your domain}:session_transfer`:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
client_id=<sending client id>&
refresh_token=<refresh token>&
audience=urn:auth.acme.com:session_transfer
```

Confidential applications authenticate as they do for any refresh, for example with `client_secret`.

```json
{
  "access_token": "Yx3f…",
  "issued_token_type": "urn:auth0:params:oauth:token-type:session_transfer_token",
  "token_type": "N_A",
  "expires_in": 60,
  "refresh_token": "v1.Mj…",
  "id_token": "eyJ…"
}
```

- The session transfer token is in `access_token`. No API access token is issued by this request.
- The request counts as a use of the refresh token. If the application rotates refresh tokens, store the `refresh_token` from the response: the one you sent is spent.
- `id_token` is included when the refresh token has the `openid` scope.
- AuthHero accepts any audience that starts with `urn:` and ends with `:session_transfer`. The domain in the middle is not compared, so the same code works on every domain of the tenant.

## Using a token

The sending application redirects the browser to the receiving application with the token, for example `https://shop.other.com/login?session_transfer_token=Yx3f…`. The receiving application starts a normal login and passes the token on:

```http
GET /authorize?
  client_id=<receiving client id>&
  response_type=code&
  redirect_uri=https://shop.other.com/callback&
  scope=openid profile&
  state=<state>&
  session_transfer_token=Yx3f…
```

If the token is good, AuthHero creates a session for the user and answers as it would for a user who is already logged in. This also works with `prompt=none` and for applications that have SSO turned off.

::: warning Treat the token like a password
Until it is used or expires, the token logs its holder in. On the receiving site:

- Redirect to `/authorize` as soon as the token arrives. Do not render a page at the URL that carries it. A page that is never rendered runs no scripts that could read the token, and loads nothing that would get it in a `Referer` header.
- Send `Referrer-Policy: no-referrer` on the response that handles the token.
- Leave the token out of request logs, error reports and analytics. Web servers and proxies log full URLs by default.

The redirect does not hide the token from the browser. A browser can keep every URL of a redirect chain in its history, and extensions can read them. The sending site can keep the token out of its own link by handing it over in a form `POST`. The request to `/authorize` still carries the token in its URL when the token is a query parameter or inside a `request` object. It does not when the token is in the cookie, which a website on another domain cannot set for the AuthHero domain, or inside an object passed by reference with `request_uri`. What limits the damage in every case is the token itself: it works once, for 60 seconds, and by default only from the IP address it was created for.

:::

An application that sends a signed Request Object (`request` or `request_uri`) must put `session_transfer_token` inside it. As with every other parameter, a value outside the signed object is ignored. The payload of a signed object is encoded, not encrypted, so an object that carries the token is as sensitive as the token. AuthHero leaves a `request` object that carries the token out of its logs, hook events and the stored authorization URL.

A `request_uri` is a reference, not the object, and AuthHero logs it as it is. Anyone who reads it there can fetch the object for as long as your server serves it. Make the URL hard to guess, and stop serving the object once it has been fetched.

There are two ways to present the token:

| Method   | How                                                          | Use it when                                                                                                            |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `query`  | `session_transfer_token` query parameter on `/authorize`     | Web to web. The receiving site forwards the parameter it was given.                                                    |
| `cookie` | `auth0_session_transfer_token` cookie on the AuthHero domain | Native to web. The native app puts the cookie into the webview before it opens the site, so the site needs no changes. |

AuthHero never sets the cookie itself. It expires the cookie after reading it. If a request carries both, the query parameter is used when the application allows `query`, otherwise the cookie.

A token is not used, and stays valid, when the request asks for a fresh login: `prompt=login`, `prompt=select_account`, `screen_hint=login`, a specific `connection`, or a `login_ticket`.

### When the browser already has a session

- **Same user:** the existing session is kept and the login completes.
- **Different user:** the existing session is revoked and the login page is shown. The token is spent.

### When a token is refused

A refused token never produces an error page. AuthHero continues with the normal login flow, so the user sees the login page (or `login_required` for `prompt=none`), and a warning (`w`) is written to the tenant logs with the reason:

| Reason                                                   | Log description starts with "Single Sign-On failed:"                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Unknown, expired or already used                         | Session Transfer Token not found or expired. This may indicate token reuse or expiration.       |
| Device binding failed                                    | Session Transfer Token device binding validation failed due to IP/ASN mismatch.                 |
| The token and the request name different organizations   | Session Transfer Token organization mismatch detected.                                          |
| The browser is logged in as someone else                 | Session Transfer Token user mismatch detected.                                                  |
| The parent refresh token is revoked or expired           | Parent refresh token not found. Session Transfer Token won't be used for session establishment. |
| The application does not allow the method used           | Session Transfer Token authentication method is not allowed for this client.                    |
| The user's connection is not enabled for the application | Session Transfer Token user's connection is not enabled for this client.                        |
| The user is blocked or deleted                           | Session Transfer Token user is blocked or no longer exists.                                     |

A token presented by a method the application does not allow is left unspent. A token that fails any other check is spent.

## Settings

Read on the **sending** application:

| Field                               | Default | Meaning                                                                                                                                                         |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can_create_session_transfer_token` | `false` | The application may exchange a refresh token for a session transfer token.                                                                                      |
| `enforce_cascade_revocation`        | `true`  | Sessions created from this application's tokens end when the refresh token they came from is revoked or expires. See [Cascade revocation](#cascade-revocation). |
| `trust_forwarded_ip`                | `false` | AuthHero extension. Bind the token to the address in the `auth0-forwarded-for` header. See [Exchanging from a backend](#exchanging-from-a-backend).             |
| `allow_onward_transfer`             | `false` | AuthHero extension. A login that arrived by session transfer may be passed on to a third application. See [Onward transfer](#onward-transfer).                  |

Read on the **receiving** application:

| Field                            | Default | Meaning                                                                                                                                                                 |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_authentication_methods` | `[]`    | `query`, `cookie` or both. Empty means the application ignores session transfer tokens.                                                                                 |
| `enforce_device_binding`         | `ip`    | `ip`, `asn` or `none`. See [Device binding](#device-binding).                                                                                                           |
| `allow_refresh_token`            | `false` | A login that arrived by session transfer may receive a refresh token when it asks for `offline_access`. When `false` the login still succeeds, without a refresh token. |
| `enforce_online_refresh_tokens`  | `true`  | Those refresh tokens stop working when the transferred session ends or expires. Using one keeps the session's idle timeout from running out.                            |

## Device binding

AuthHero records the IP address of the request that created a token and compares it with the browser that presents it:

- **`ip`** (default): the addresses must be identical. A user whose requests alternate between IPv4 and IPv6 fails this check and sees the login page.
- **`asn`**: both requests must come from the same network provider. This needs a runtime that reports the autonomous system number, such as Cloudflare Workers. Without one, every token is refused.
- **`none`**: no check.

::: warning Query tokens without device binding
With `query` allowed and `enforce_device_binding: "none"`, anyone who opens a link that carries a valid token is logged in as its user. An attacker can send their own link to sign someone in to the attacker's account, and a leaked link works from anywhere until the token is used or expires. Keep a device check on, or accept the cookie only.
:::

### Exchanging from a backend

When the sending application's server makes the exchange, the token is bound to the server's address, and a receiving application that checks the IP address refuses it. To bind the token to the user instead, set `trust_forwarded_ip` on the sending application and send the user's address with the exchange:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
auth0-forwarded-for: 203.0.113.42

grant_type=refresh_token&
client_id=<sending client id>&
client_secret=<secret>&
refresh_token=<refresh token>&
audience=urn:auth.acme.com:session_transfer
```

The header is only honoured when the request is authenticated with a client secret or a client assertion. It is ignored for public applications, which could otherwise claim any address. A token bound to a forwarded address has no network recorded, so it cannot be used by a receiving application set to `asn`.

A single-page application that makes the exchange from the browser does not need this: the request already comes from the user's address.

## Cascade revocation

A session created from a session transfer token remembers the refresh token it came from. If the sending application has `enforce_cascade_revocation` on when the session transfer token is issued, that session, and the refresh tokens issued in it, end when the parent refresh token is revoked or expires. Changing the setting later does not affect existing sessions. Rotating the parent does not count: the link follows the whole rotation chain.

The check runs when the session is next used at `/authorize` and when one of its refresh tokens is exchanged. Nothing happens at the moment the parent is revoked, so access tokens that were already issued remain valid until they expire.

Logging out of the receiving application does not affect the sending application's refresh token.

## Onward transfer

By default a login that arrived by session transfer cannot create another token: the exchange is refused with `invalid_grant`. Set `allow_onward_transfer` on an application to let it pass the session on (A → B → C). That application also needs `can_create_session_transfer_token`, and `allow_refresh_token` so it has a refresh token to exchange.

Every hop stays tied to the refresh token the chain started from, and once any hop asked for cascade revocation, the hops after it keep it.

## What the new session looks like

- It keeps the original login time (`auth_time`).
- It keeps the authentication methods of the sending application's session, so a user who passed MFA there counts as having passed it on the receiving application. This only applies while that session is still valid when the token is created. If it has been revoked or has expired, the new session starts without a completed MFA.
- It records where it came from. [Post-login hooks](/features/hooks) see this on the event:

```js
exports.onExecutePostLogin = async (event, api) => {
  // Only on the login that used the token
  if (event.session_transfer_token) {
    event.session_transfer_token.client_id; // the sending application
    event.session_transfer_token.scope; // scope of the parent refresh token
    event.session_transfer_token.request.ip; // address the token was bound to
    event.session_transfer_token.request.asn;
    event.session_transfer_token.request.user_agent;
  }

  // On every login that uses the transferred session
  if (event.session?.session_transfer) {
    event.session.session_transfer.client_id;
    event.session.session_transfer.parent_refresh_token.id;
  }
};
```

A hook can use this to refuse a transferred login, or to require MFA again, for sensitive applications.

## Errors

Refusals at `/authorize` are described under [When a token is refused](#when-a-token-is-refused). The exchange at `/oauth/token` can fail in these ways:

| Situation                                                                               | Response                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The application lacks `can_create_session_transfer_token`                               | `403 unauthorized_client` "Client is not allowed to create session transfer tokens"        |
| The login arrived by session transfer and the application lacks `allow_onward_transfer` | `403 invalid_grant` "Session transfer tokens cannot be created from a transferred session" |
| The refresh token is invalid, expired or revoked                                        | The same `invalid_grant` response as any refresh                                           |

`invalid_grant` is returned with status 400 instead of 403 for applications that have `auth0_conformant` set to `false`, as for every refresh token error.

A successful exchange is logged as `sertft` and a refused one as `fertft`, both with the session transfer audience. The token itself is never written to the logs, and it is removed from the authorization URL that login logs record.

## Differences from Auth0

- **Any application type may create tokens.** Auth0 limits this to native applications. AuthHero allows web applications and single-page applications too, which is what makes web-to-web transfer possible.
- **Tokens work on every domain of the tenant.** A token created through one custom domain can be used through another.
- **`trust_forwarded_ip` and `allow_onward_transfer`** are AuthHero extensions, both off by default.
- **Three extra refusal reasons** are logged: method not allowed, connection not enabled, and user blocked or deleted.
- **The parent is the refresh token's rotation chain**, not a single token, so rotating the sending application's refresh token does not end transferred sessions.
- **Not implemented:** Session Delegation (actor tokens), handing a session to a SAML or WS-Federation application, and transfer between tenants.
