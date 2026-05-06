---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Support EC signing keys (ES256/ES384/ES512) for ID and access tokens. The signing algorithm is now derived from the key material at issue time, so a tenant can swap its `jwt_signing` key from RSA to EC P-256/P-384/P-521 (via `createX509Certificate({ keyType: "EC-P-256" })`) without changing any other configuration. RSA keys continue to sign with RS256.

Discovery now advertises `id_token_signing_alg_values_supported: ["RS256", "ES256", "ES384", "ES512"]`, and `/.well-known/jwks.json` publishes EC keys with the proper `kty`/`crv`/`x`/`y` members and an explicit `alg`. The exported `jwksSchema` no longer requires `n` and `e` (those are now optional, alongside the new EC fields), so consumers narrowing on `kty` before reading members may need a small adjustment.

PS256/PS384/PS512 are not yet supported; they require an explicit per-key alg field and will follow in a subsequent change.
