---
title: Authorize Endpoint
description: Reference for AuthHero authorize parameters, including login language, PKCE, connections, organizations, session behavior, and signed request objects.
---

# Authorize Endpoint

`GET /authorize` starts an OAuth 2.0 / OpenID Connect authorization flow. Open
the URL in the user's browser. AuthHero authenticates the user and returns the
authorization response to the application's registered callback URL.

For an end-to-end walkthrough, see [Your first login](/first-login#build-the-authorize-url).
This page describes the accepted request parameters; the schema for your installed
version is also available at `GET /.well-known/openapi.json` on your AuthHero server.

## Authorization code example

```text
https://login.example.com/authorize
  ?client_id=YOUR_CLIENT_ID
  &response_type=code
  &redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback
  &scope=openid%20profile%20email
  &state=RANDOM_STATE
  &nonce=RANDOM_NONCE
  &code_challenge=PKCE_CHALLENGE
  &code_challenge_method=S256
  &ui_locales=sv%20en
```

Join the lines into one URL and replace the placeholders. Generate a fresh state,
nonce, and PKCE verifier for each login. Send the verifier's SHA-256 challenge here
and the original verifier when exchanging the code at `/oauth/token`.

## Core parameters

| Parameter               | Usage                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`             | Required. The application's client ID. [CIMD clients](/standards/cimd) use an HTTPS metadata URL instead.                                                                                                                                                                                                                           |
| `response_type`         | Required for a new authorization request. Use `code` for authorization code flow. Also accepts `token`, `id_token`, `id_token token`, `code id_token`, `code token`, and `code id_token token`.                                                                                                                                     |
| `redirect_uri`          | The callback URL, registered in the application's allowed callback URLs. Send it explicitly; if omitted, the login flow can fall back to a registered callback.                                                                                                                                                                     |
| `scope`                 | Space-separated scopes. Include `openid` for OpenID Connect, `profile` and `email` for those claims, and `offline_access` to request a refresh token.                                                                                                                                                                               |
| `state`                 | An opaque value returned to your callback. Generate and verify it to protect against CSRF. Required for silent authentication.                                                                                                                                                                                                      |
| `nonce`                 | Binds an ID token to the request. Verify it in the returned ID token; required for implicit and hybrid ID-token responses.                                                                                                                                                                                                          |
| `code_challenge`        | PKCE challenge derived from the verifier that will be sent to `/oauth/token`.                                                                                                                                                                                                                                                       |
| `code_challenge_method` | `S256` (recommended) or `plain`. CIMD clients require PKCE with `S256` for code flows.                                                                                                                                                                                                                                              |
| `response_mode`         | `query`, `fragment`, `form_post`, `web_message`, or `saml_post`. Code flow defaults to `query`; token responses default to `fragment`. `query` is rejected for response types that include tokens. See [Form Post](/standards/oauth2-form-post) and [Embedded Login](/customization/embedded-login) for specialized delivery modes. |
| `audience`              | Identifier of the API whose access token you want. When omitted, the tenant's `default_audience` is used if configured. See [Resource Servers](/entities/security/resource-servers).                                                                                                                                                |
| `resource`              | RFC 8707 resource indicator, mapped to `audience`. If both are provided, they must match.                                                                                                                                                                                                                                           |

## Login experience and sessions

| Parameter      | Usage                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui_locales`   | Space-separated language tags in preference order, such as `sv en` or `nb-NO en`. See [Selecting a language](#selecting-a-language).                                                                                                                                                                                                                                       |
| `connection`   | Connection name to use. External connections can redirect directly to the provider; `email` selects email passwordless login when available.                                                                                                                                                                                                                               |
| `login_hint`   | User identifier, such as an email address, used to initialize the login flow.                                                                                                                                                                                                                                                                                              |
| `screen_hint`  | Accepted as a screen hint. `login` prevents automatic reuse of the existing Universal Login session. Although `signup` is accepted, it currently does not select a signup screen.                                                                                                                                                                                          |
| `prompt`       | `none` attempts silent authentication; `login` forces reauthentication. `select_account` also forces reauthentication because AuthHero maintains a single session per browser. Interactive prompt values can be space-separated. Send `none` alone. Other values are accepted but do not necessarily change behavior; consent is governed by the client and stored grants. |
| `max_age`      | Maximum age of the existing authentication in seconds. An older session requires reauthentication; silent authentication returns an error when it cannot reuse the session.                                                                                                                                                                                                |
| `organization` | Organization ID or name for the login context. See [Organizations](/entities/identity/organizations).                                                                                                                                                                                                                                                                      |
| `acr_values`   | Space-separated authentication context preferences. The first value is echoed as `acr` in the ID token; this parameter does not itself enforce MFA or a particular authentication strength.                                                                                                                                                                                |

### Selecting a language

Append `&ui_locales=sv` to request Swedish, or `&ui_locales=sv%20en` to send
Swedish followed by English. Encode spaces as `%20` or build the query with
`URLSearchParams`:

```javascript
// url is your authorize URL with the core parameters already set.
url.searchParams.set("ui_locales", "sv en");
window.location.assign(url.toString());
```

The bundled login translations are English (`en`), Italian (`it`), Norwegian
Bokmål (`nb`), Swedish (`sv`), Polish (`pl`), Czech (`cs`), Finnish (`fi`), and
Danish (`da`). Regional tags such as `nb-NO` use the corresponding language's
translations.

For Universal Login v2 (`/u2`), explicit `ui_locales` preferences take priority
over the browser's `Accept-Language` header. If the tenant sets `enabled_locales`,
requests outside those languages are skipped, and the first enabled locale is
the fallback. Without that setting, the fallback is English. Translation text
also depends on the available translation catalog and tenant custom text.

Classic Universal Login (`/u`) selects from `ui_locales`, restricted to its
supported translations and the tenant's enabled locales. It does not use
`Accept-Language`; its fallback is the tenant's first enabled locale or English.

## Claims and signed requests

| Parameter     | Usage                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims`      | JSON-encoded OIDC claims request, with `id_token` and/or `userinfo` members. Inside a signed Request Object, it can be a JSON object. See [OIDC Core](/standards/openid-connect-core). |
| `request`     | Signed JWT containing the authorization parameters. Unsigned JWTs (`alg=none`) are rejected.                                                                                           |
| `request_uri` | URL from which AuthHero fetches a signed Request Object JWT, subject to SSRF protection. Mutually exclusive with `request`.                                                            |

When using `request` or `request_uri`, the outer `client_id` is required and must
match the signed `client_id`. Authorization parameters come from the verified
JWT; unsigned query parameters do not fill gaps or override it. See
[JWT-Secured Authorization Requests](/standards/rfc-9101) for details.

## Compatibility parameters

These parameters are accepted for integration flows rather than normal browser
login configuration.

| Parameter      | Usage                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `login_ticket` | Ticket used to complete a previously authenticated flow, such as cross-origin authentication.                                           |
| `realm`        | Realm used with the login-ticket flow: `email` or `Username-Password-Authentication`.                                                   |
| `auth0Client`  | Auth0-compatible SDK metadata, normally supplied by an SDK.                                                                             |
| `vendor_id`    | Integration metadata stored with the authorization parameters. It does not replace `client_id` for selecting the application or tenant. |

Unknown query parameters are accepted for compatibility; acceptance does not
imply they change login behavior. For failures such as `login_required` and
`consent_required`, see [Error Codes](/api/error-codes).
