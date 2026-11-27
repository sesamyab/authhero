---
title: Home Realm Discovery
description: Send users straight to their company's identity provider based on the domain of the email address they enter, using domain aliases on a connection.
---

# Home Realm Discovery

Home Realm Discovery (HRD) sends a user straight to their organization's identity provider based on the email address they type. When `alice@acme.com` enters her email on the login page and the Acme connection lists `acme.com` as a domain alias, AuthHero skips the password and code steps and redirects her to Acme's IdP.

HRD works like [Auth0's identifier-first Home Realm Discovery](https://auth0.com/docs/authenticate/login/auth0-universal-login/identifier-first). You configure it with the same field: `options.domain_aliases` on a connection. In the admin UI the field is called **Domain Aliases**.

```
user                       AuthHero login page                    Acme IdP
 │  enters alice@acme.com ──▶│                                          │
 │                           │ acme.com is in domain_aliases            │
 │                           │ of the "acme-oidc" connection            │
 │◀── 302 to Acme /authorize?login_hint=alice@acme.com ────────────────▶│
```

## How it works

HRD runs when the user submits the identifier screen, on both the classic login (`/u/login/identifier`) and the screen-based login (`/u2/login/identifier`):

1. If the identifier is an email address, AuthHero takes the domain after the last `@`. Leading and trailing whitespace is removed and case is ignored.
2. It goes through the connections enabled on the application and keeps those whose `options.domain_aliases` contains that domain. The comparison is case-insensitive.
3. If **exactly one** connection matches, the user is redirected to that connection's identity provider. The email is stored on the login session and sent to the IdP as `login_hint`.
4. If no connection matches, or several do, the login continues as normal (password, code or signup).

Some consequences:

- **HRD takes priority over local accounts.** A user with a database password account whose email domain matches a domain alias is still sent to the IdP. Put a domain on a connection only when every user with that domain should sign in there.
- **Ambiguous domains are skipped.** If two connections enabled on the same application list the same domain, AuthHero does not guess. HRD is skipped for that domain, and the user sees the normal login steps.
- **Only enabled connections count.** A connection that is not enabled on the application is ignored, even if it lists the domain.
- **Usernames and phone numbers are not affected.** HRD only runs for email identifiers.

### Supported strategies

HRD routes only to strategies that use a redirect-based login. The built-in ones are:

| Strategy                                                               | Example                       |
| ---------------------------------------------------------------------- | ----------------------------- |
| `oidc`                                                                 | Any OpenID Connect provider   |
| `okta`                                                                 | Okta                          |
| `waad`                                                                 | Microsoft Entra ID (Azure AD) |
| `samlp`                                                                | Any SAML 2.0 identity provider |
| `oauth2`                                                               | Generic OAuth 2.0 provider    |
| `google-oauth2`, `windowslive`, `github`, `facebook`, `apple`, `vipps` | Social providers              |

Custom strategies registered through `env.STRATEGIES` are supported as well.

`domain_aliases` is **ignored** on `Username-Password-Authentication` and other database connections, and on `email`, `sms` and `adfs` connections. The admin UI hides the field for those strategies.

`login_hint` is forwarded to the IdP by the `oidc`, `okta`, `oauth2`, `google-oauth2`, `waad` and `windowslive` strategies. Other strategies redirect without it.

### Login buttons

A connection with domain aliases is meant to be reached through the email field, so it is **hidden** from the "Continue with …" button row by default. You can override that with `show_as_button` on the connection:

| `domain_aliases` | `show_as_button` | Button shown? |
| ---------------- | ---------------- | ------------- |
| not set          | not set          | yes           |
| set              | not set          | no            |
| set              | `true`           | yes           |
| any              | `false`          | no            |

The **Connections** tab of an application in the admin UI shows which connections are hidden and why ("HRD: routed by email domain").

### Signup

When a user arrives through HRD for the first time, the account is created through the connection, like any other federated login. To stop new users from signing up through the connection, set `options.disable_signup: true` on it. See [User Creation Flow](./user-creation-flow).

## Configuration

### Admin UI

1. Open **Connections** and select the enterprise or social connection.
2. Under **Domain Aliases**, add one entry per email domain, for example `acme.com` and `acme.se`. Enter only the domain, without `@`.
3. Save, and make sure the connection is enabled on the applications that should use it (the **Connections** tab of the application).

### Management API

Create a connection with domain aliases:

```http
POST /api/v2/connections
Authorization: Bearer {management_api_token}
Content-Type: application/json

{
  "name": "acme-oidc",
  "strategy": "oidc",
  "display_name": "Acme",
  "options": {
    "client_id": "acme-client-id",
    "client_secret": "acme-client-secret",
    "discovery_url": "https://login.acme.com/.well-known/openid-configuration",
    "scope": "openid profile email",
    "domain_aliases": ["acme.com", "acme.se"]
  }
}
```

Enable it on an application:

```http
PATCH /api/v2/connections/{connection_id}/clients
Authorization: Bearer {management_api_token}
Content-Type: application/json

[
  { "client_id": "{client_id}", "status": true }
]
```

To change the domains on an existing connection, update `options`:

```http
PATCH /api/v2/connections/{connection_id}
Authorization: Bearer {management_api_token}
Content-Type: application/json

{
  "options": {
    "client_id": "acme-client-id",
    "discovery_url": "https://login.acme.com/.well-known/openid-configuration",
    "scope": "openid profile email",
    "domain_aliases": ["acme.com", "acme.se", "acme.no"]
  }
}
```

::: warning `options` is replaced, not merged
As in Auth0, a `PATCH` that includes `options` replaces the whole object. Read the connection first with `GET /api/v2/connections/{connection_id}` and send back every option you want to keep. The one exception is secrets such as `client_secret`: they are left out of `GET` responses, so AuthHero keeps the stored value when a `PATCH` doesn't include one.
:::

To show the connection as a button as well, set `show_as_button` at the top level of the connection, not inside `options`:

```http
PATCH /api/v2/connections/{connection_id}
Content-Type: application/json

{ "show_as_button": true }
```

## Compared with Auth0

|                              | Auth0                                           | AuthHero                                                                          |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Configuration field          | `options.domain_aliases`                        | `options.domain_aliases`                                                          |
| Where it runs                | Identifier-first Universal Login                | Identifier screen on `/u` and `/u2`                                               |
| Eligible connections         | Enterprise connections, including SAML and ADFS | Redirect-based enterprise (including SAML) **and social** connections; ADFS not supported |
| `login_hint` sent to the IdP | Yes                                             | Yes, for `oidc`, `okta`, `oauth2`, `google-oauth2`, `waad` and `windowslive`      |
| Hidden from the button row   | Yes, unless shown as a button                   | Yes, unless `show_as_button: true`                                                |
| Matching                     | Exact domain                                    | Exact domain, case-insensitive; no wildcards or subdomain matching                |

The differences that matter when migrating from Auth0:

- **ADFS connections don't support HRD yet.** On AuthHero, users of an `adfs` connection need a login button or a `connection` parameter on `/authorize`. SAML (`samlp`) connections do take part, so an ADFS server can be connected as a SAML IdP instead.
- **Social connections can use HRD.** Auth0 only offers domain aliases on enterprise connections. AuthHero also accepts them on, for example, `google-oauth2`, which is useful when one company's Google Workspace domain should always go to Google.
- **Subdomains must be listed explicitly.** `acme.com` does not match `eu.acme.com`.

## Skipping the login page entirely

HRD needs the user to type an email address first. If your application already knows which connection to use, pass it on the authorization request instead, and AuthHero redirects straight to the IdP without showing a login page:

```
GET /authorize?client_id=…&response_type=code&redirect_uri=…&connection=acme-oidc
```
