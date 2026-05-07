---
title: OpenID Connect Core 1.0
description: AuthHero's implementation status for the OpenID Connect Core 1.0 specification.
---

# OpenID Connect Core 1.0

**Spec:** [openid.net/specs/openid-connect-core-1_0.html](https://openid.net/specs/openid-connect-core-1_0.html)
**Status:** Partial

OpenID Connect Core layers identity semantics on top of OAuth 2.0: ID tokens, the UserInfo endpoint, and standard claims.

## Implemented

- **Authorization Code Flow** — `response_type=code`, with an ID token returned from the token endpoint.
- **Hybrid Flow** — `code id_token`, `code token`, `code token id_token`.
- **Implicit Flow response types** — `id_token` and `token id_token` are accepted, though direct implicit is discouraged.
- **ID Token** — signed JWT containing `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce`, `acr` when requested. Signed with the tenant's `jwt_signing` key; RS256 is the default and EC keys produce ES256/ES384/ES512 depending on the curve.
- **Nonce** — round-tripped and validated to prevent replay.
- **`max_age` / `auth_time`** — enforced per OIDC Core §3.1.2.1; re-authentication is required when the existing session is older than `max_age`.
- **`acr_values`** — forwarded and echoed into the ID token.
- **UserInfo endpoint** — `GET` and `POST /userinfo`, scope-filtered (`openid`, `profile`, `email`, `address`, `phone`).
- **Standard claims** — `sub`, `email`, `email_verified`, `name`, `given_name`, `family_name`, `middle_name`, `nickname`, `preferred_username`, `profile`, `picture`, `website`, `gender`, `birthdate`, `zoneinfo`, `locale`, `phone_number`, `phone_number_verified`, `address` (per §5.1.1).
- **`prompt`** — `none`, `login`, `consent`, and `select_account` behaviors.
- **Request Objects (§6)** — `request` and `request_uri` parameters are accepted and signature-verified. See [RFC 9101 — JAR](/standards/rfc-9101).
- **Client authentication (§9)** — `client_secret_basic`, `client_secret_post`, `client_secret_jwt`, and `private_key_jwt`. See [RFC 7523](/standards/rfc-7523).

## Partial / not yet implemented

- **Pairwise subject identifiers** — only `public` subject type is supported.
- **Claims parameter** — the `claims` request parameter (OIDC Core §5.5) for requesting specific claims is partially honored (`essential` claims tracked in [#781](https://github.com/markusahlstrand/authhero/issues/781)).
- **Encrypted ID tokens / UserInfo** — JWE encryption (`id_token_encrypted_response_alg`, `userinfo_encrypted_response_alg`) is not supported.

## Related AuthHero documentation

- [OpenID Connect Discovery](/standards/openid-connect-discovery)
- [Authentication Flows](/features/authentication-flows)
- [Tokens](/entities/security/tokens)
