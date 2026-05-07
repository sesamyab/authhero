---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Support `private_key_jwt` and `client_secret_jwt` client authentication at `/oauth/token` (RFC 7523 §3 / OIDC Core §9). Clients can now authenticate by sending a signed JWT in `client_assertion` instead of a `client_secret`.

How it works:

- The client posts `client_assertion=<JWT>` and `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`. `client_id` may be sent as a form field or omitted (in which case it's derived from the assertion's `sub` claim).
- For `private_key_jwt` (asymmetric), the assertion is verified against the client's `registration_metadata.jwks` (inline) or `client_metadata.jwks_uri` (fetched with the same SSRF guard used by request objects). RS256/RS384/RS512 + ES256/ES384/ES512 are accepted.
- For `client_secret_jwt` (HMAC), the assertion is verified against the client's stored `client_secret`. HS256/HS384/HS512 are accepted.
- The verifier enforces RFC 7523 claims: `iss == sub == client_id`, `aud` matching the token endpoint URL or the OP issuer, required `exp` (with 30 s leeway), optional `nbf`. `alg=none` is rejected.
- Sending both `client_secret` and `client_assertion` is rejected with `invalid_request`.
- All existing grants (authorization_code, client_credentials, refresh_token) honor the assertion: their `client_secret` comparison is skipped when the request authenticated via assertion. `code_verifier` (PKCE) still applies to the authorization-code grant when present.

Schema / discovery:

- `Client.token_endpoint_auth_method` now accepts `client_secret_jwt` and `private_key_jwt` alongside the existing values. Dynamic Client Registration accepts the same values for `token_endpoint_auth_method`.
- Discovery's `token_endpoint_auth_methods_supported` now lists `["client_secret_basic", "client_secret_post", "client_secret_jwt", "private_key_jwt"]`.

For replay protection, this release validates `exp` (and the optional `nbf`) but does not yet track `jti`. Most basic OIDC conformance test plans pass with `exp`-only; FAPI requires `jti` tracking, which can be added later as a separate change.
