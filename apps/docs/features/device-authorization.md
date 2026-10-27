---
title: Device Authorization
description: Sign users in on TVs, command-line tools, and other input-constrained devices with OAuth 2.0 Device Authorization Grant.
---

# Device Authorization

AuthHero supports the [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628). A device displays a code and a verification URL. The user opens the URL in a browser, signs in, checks the code, and approves or denies the request. The device polls for tokens while the user completes these steps.

Activation uses the **u2 login experience**, including the application's enabled connections, email verification, MFA, and post-login hooks. The browser must explicitly approve each request.

## Configure the application

Enable **Device Code** in the application's grant types. Its wire value is:

```text
urn:ietf:params:oauth:grant-type:device_code
```

For a public device application, set `token_endpoint_auth_method` to `none`. Public applications send their `client_id` without a secret. Confidential applications can use `client_secret_basic` or `client_secret_post`. The token endpoint also supports the existing client assertion authentication methods.

Enable the `refresh_token` grant as well if the application will exchange refresh tokens. Request `openid` for an ID token and `offline_access` for a refresh token.

The Kysely, Drizzle, and DynamoDB adapters provide device-code storage. Apply the new SQL migrations before using the flow. Custom adapters must implement the optional `deviceCodes` adapter; discovery advertises the endpoint when that adapter is configured. Expired device codes and attempt counters are included in `runRetention`; DynamoDB uses TTL.

## Request a code

```sh
curl https://auth.example.com/oauth/device/code \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=YOUR_CLIENT_ID' \
  --data-urlencode 'scope=openid email offline_access' \
  --data-urlencode 'include_qr_code=true' \
  --data-urlencode 'audience=https://api.example.com'
```

`scope` and `audience` are optional. A supplied audience must identify a configured resource server. API scopes are narrowed through the normal token permission checks.

The response contains:

```json
{
  "device_code": "OPAQUE_DEVICE_CREDENTIAL",
  "user_code": "BCDF-GHJK",
  "verification_uri": "https://auth.example.com/activate",
  "verification_uri_complete": "https://auth.example.com/activate?user_code=BCDF-GHJK",
  "qr_code": "data:image/svg+xml;base64,...",
  "expires_in": 600,
  "interval": 5
}
```

Set `include_qr_code=true` to request a `qr_code` response field containing an SVG image data URL. JSON requests may use a boolean; form requests use the string `true`. The QR image encodes `verification_uri_complete`, including its tenant hint and user code. It contains no device credential. The field is omitted by default and when the option is false.

On the requesting device, set an image's `src` to this data URL and display the user code alongside it. The user scans the image with their phone to open the activation page; they still confirm the matching code before approving access.

Display the `user_code` and `verification_uri`. You can also open or encode `verification_uri_complete` as a QR code. The browser still displays the code for confirmation. Keep the `device_code` on the device; it is the credential used to collect tokens.

Use the verification URLs exactly as returned. Shared-host deployments include a `tenant_id` query parameter so activation reaches the correct tenant. User-code entry accepts lowercase letters and ignores spaces and dashes. Activation attempts are limited per browser session and IP.

## Poll for tokens

```sh
curl https://auth.example.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  --data-urlencode 'client_id=YOUR_CLIENT_ID' \
  --data-urlencode 'device_code=OPAQUE_DEVICE_CREDENTIAL'
```

Respect the returned `interval` between polls. Pending responses use HTTP 400 with an OAuth error:

| Error                   | Device behavior                                                                |
| ----------------------- | ------------------------------------------------------------------------------ |
| `authorization_pending` | Keep polling at the current interval.                                          |
| `slow_down`             | Increase the interval by **5 seconds** for this and all subsequent polls.      |
| `access_denied`         | Stop; the user denied the request.                                             |
| `expired_token`         | Stop; obtain a fresh code to start again.                                      |
| `invalid_grant`         | Stop; the code is invalid, belongs to another client, or was already redeemed. |

After approval, the response contains the normal OAuth tokens, including an ID token or refresh token when requested. Device codes are single use, including when requests arrive concurrently.

Both `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server` advertise `device_authorization_endpoint` and the device grant type.

## Protocol tests

The pinned OpenID Foundation suite (`release-v5.2.4`) has no device authorization test plan. AuthHero covers the grant with its HTTP integration tests, including the pending/backoff/success cycle, denial, expiry, replay, concurrent redemption, client binding, u2 sign-in, MFA, and post-login hooks:

```sh
pnpm authhero test test/routes/auth-api/device-flow.spec.ts
pnpm conformance:device
```

The normal discovery tests also cover the updated provider metadata. SQL adapter tests verify atomic updates, tenant isolation, uniqueness, attempt counters, and retention; DynamoDB command tests verify conditional writes, transactions, consistent reads, and TTLs.
