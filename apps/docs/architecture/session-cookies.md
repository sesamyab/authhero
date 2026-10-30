---
title: Session cookies
description: Which cookies AuthHero sets on the login domain, why the session cookie is set both partitioned and non-partitioned, and how to troubleshoot a browser that keeps asking the user to log in.
---

# Session cookies

AuthHero remembers a signed-in browser with a session cookie on the login domain. Every `/authorize` request reads it to decide between single sign-on (SSO) and showing the login screen. This page describes the cookies AuthHero sets, why they have the attributes they have, and how to find out what happened when a user says they have to log in every time.

## The cookies

| Cookie                             | Set by                                                                  | Attributes                                                                                             | Purpose                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{tenant_id}-auth-token`           | `/authorize/resume`, silent auth, token endpoints that create a session | `HttpOnly; Secure; SameSite=None`, 30 days, set **twice**: once non-partitioned and once `Partitioned` | The session id. Read on `/authorize` for SSO and on logout to revoke the session.                                                        |
| `{tenant_id}-last-used-connection` | Login screens, when `show_last_used_connection` is on                   | `HttpOnly; Secure; SameSite=Lax`, not partitioned                                                      | The name of the connection the user last logged in with, for the "Last used" badge. Holds no personal data.                              |
| `authhero-private-browsing`        | The login page's own script                                             | `SameSite=Lax`, session cookie, login host only, not `HttpOnly`                                        | `1` or `0`, the result of the private-browsing check on the login page. Only used for logging (see [Troubleshooting](#troubleshooting)). |

All of them use `Path=/`. The first two are scoped to the registrable domain (`login.example.com` → `Domain=.example.com`), so a custom login domain shares them with the rest of the site.

On `localhost`, `127.0.0.1`, `::1` and `host.docker.internal` the session cookie is set once, without `Secure` or `Partitioned` and with `SameSite=Lax`. Browsers reject `Secure` cookies over plain HTTP, and `SameSite=None` requires `Secure`.

## Why the session cookie is set twice

The browser stores the non-partitioned cookie and the `Partitioned` cookie ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)) as two separate cookies, even though they have the same name. AuthHero sets both, with the same value, because each one works where the other one doesn't.

A partitioned cookie is stored per **top-level site**: a login page shown inside an iframe on `shop.example.org` writes to a jar that only exists under `shop.example.org`. A non-partitioned cookie has one jar for the whole browser, but browsers that block third-party cookies refuse it inside a cross-site iframe.

| Where `/authorize` runs                                                                         | Non-partitioned cookie                        | Partitioned cookie                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Top-level page (redirect login, or a link or 302 from another site into login)                  | Sent                                          | Should be sent, but some Safari configurations don't send it when the navigation arrives through a cross-site redirect |
| Same-site iframe (`www.example.com` embedding `login.example.com`, the usual silent-auth setup) | Sent                                          | Sent                                                                                                                   |
| Cross-site iframe, user logged in inside that iframe (u2 embed mode on a third-party site)      | Rejected when third-party cookies are blocked | Sent: stored in that site's jar, found on later visits under the same site                                             |
| Cross-site iframe, user only logged in at top level                                             | Rejected when third-party cookies are blocked | Not found: that site's jar is empty                                                                                    |

So:

- The **non-partitioned** cookie handles top-level navigations and same-site iframes. AuthHero only set the partitioned cookie between January and October 2026, and some iOS Safari users then lost SSO on top-level `/authorize` requests that arrived through a cross-site 302 ([#1639](https://github.com/markusahlstrand/authhero/issues/1639)). On the same request the browser still sent the non-partitioned `last-used-connection` cookie.
- The **partitioned** cookie handles login and silent auth inside a cross-site iframe, [embedded login](/customization/embedded-login) on a third-party site, once third-party cookies are blocked.

Both are `SameSite=None` so the session also reaches cross-site `POST`s to the login domain, such as a SAML `HTTP-POST` binding request to `/samlp` or `POST /authorize`. `Lax` would drop the cookie on those.

### Comparison with Auth0

Auth0's session cookie (`auth0`) is `SameSite=None; Secure` and not partitioned, plus an `auth0_compat` fallback for browsers that don't understand `SameSite=None`. Auth0 doesn't need a partitioned cookie because its Universal Login can't be shown in an iframe by default (clickjacking protection). AuthHero supports embedded login, so it sets both. Neither cookie is worse than the other in any context, so there is no setting to turn one of them off.

## Reading and clearing

- `/authorize` reads **every** value of `{tenant_id}-auth-token` from the `Cookie` header and uses the first one that points to a session that isn't revoked. Usually both cookies hold the same value. They can differ after a login inside a cross-site iframe in a browser that still allows third-party cookies: that login overwrites the shared non-partitioned cookie, while the partitioned cookie at top level keeps the older session.
- Logout (`/v2/logout`, `/oidc/logout`, SAML logout) and the `login_required` path of silent auth send two `Max-Age=0` cookies, one non-partitioned and one `Partitioned`, so both are removed. Logout reads one cookie value to decide which session to revoke. In the different-sessions case above, the other session stays valid on the server but its cookie has been removed in that context.

The server can't tell from the `Cookie` header which jar a value came from. When two values arrive, both jars sent one.

## Troubleshooting

When the session cookie is missing on `/authorize`, AuthHero shows the login screen and writes no error log: from the server's side that looks the same as a first visit. To make these cases traceable, `/authorize` records what the browser sent and stores it on the login session. When the login completes, it is copied into the **Successful login** (`s`) log's `details`:

```json
{
  "session_cookie": {
    "received": 0,
    "result": "none",
    "cookies": 3,
    "last_used": true,
    "fetch_site": "cross-site",
    "fetch_dest": "document",
    "referrer": "reader.vendor.example"
  },
  "private_browsing": false
}
```

| Field                                        | Meaning                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `received`                                   | How many `auth-token` values arrived: `0`, `1`, or `2` when both jars sent one.                                                                                                                                                                       |
| `result`                                     | `none` (no session cookie), `not_found` (the session id doesn't exist, for example expired and cleaned up), `revoked`, `valid` (SSO), or `sso_disabled` (the client has SSO turned off, so the session was ignored).                                  |
| `cookies`                                    | How many cookies of any name the browser sent. `0` means it sent nothing for this domain.                                                                                                                                                             |
| `last_used`                                  | Whether the non-partitioned `SameSite=Lax` last-used cookie arrived. Only meaningful when the tenant shows the "Last used" badge.                                                                                                                     |
| `fetch_site`, `fetch_dest`, `storage_access` | The `Sec-Fetch-Site`, `Sec-Fetch-Dest` and `Sec-Fetch-Storage-Access` request headers. `cross-site` + `document` is a top-level navigation from another site; `iframe` means the request ran in a frame. `Sec-Fetch-Storage-Access` is Chromium-only. |
| `referrer`                                   | The host of the `Referer`, never the full URL.                                                                                                                                                                                                        |
| `private_browsing`                           | The login page's private-browsing check (`detectincognitojs`). Missing when the page couldn't run it, for example in embed mode or in an in-app browser.                                                                                              |

None of the fields hold cookie values or personal data. Logs don't record which cookie attributes were set, because those don't change per request; they're described on this page.

How to read a repeated "login every time" report:

1. Find the user's `s` logs for the client that keeps asking them to log in.
2. `result: "valid"` means SSO worked for that login, so the problem is elsewhere.
3. `received: 0` with `cookies > 0` means the browser sent other cookies for the domain but no session cookie. If `last_used` is `true`, a non-partitioned `Lax` cookie got through on the same request, which points at the browser handling `SameSite=None` or `Partitioned` cookies differently. Compare `fetch_site` and `referrer` with the user's working logins.
4. `cookies: 0` means the browser sent nothing at all: private browsing (check `private_browsing`), cleared site data, or a browser that blocks all cookies for the domain.
5. `result: "not_found"` or `"revoked"` means the cookie arrived but the session is gone. Look for a logout, a revocation, or session expiry.

`session_cookie` is only recorded for logins that start with an interactive `/authorize`. Silent auth (`prompt=none`) that finds no session writes no log, so a working `ssa` (successful silent auth) log next to an `s` log with `received: 0` for a different client is the pattern to look for.
