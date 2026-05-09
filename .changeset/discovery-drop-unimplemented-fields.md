---
"@authhero/adapter-interfaces": patch
"authhero": patch
---

Stop advertising endpoints and response types we don't actually implement in `/.well-known/openid-configuration`:

- Removed `device_authorization_endpoint` (`/oauth/device/code`) — no device-code route is registered.
- Removed `mfa_challenge_endpoint` (`/mfa/challenge`) — Universal-Login MFA lives at `/u2/mfa/*` and is a UI flow, not the headless Auth0 `mfa-challenge` API.
- Narrowed `response_types_supported` to `["code", "token", "id_token", "id_token token"]`. The hybrid variants (`code token`, `code id_token`, `code id_token token`) were advertised but never handled; they remain unsupported by design (see the AuthHero vs Auth0 docs for the rationale). Clients should use `code` + PKCE.

`device_authorization_endpoint` and `mfa_challenge_endpoint` are also dropped from `openIDConfigurationSchema` in `@authhero/adapter-interfaces`.
