---
"authhero": patch
---

Fix OIDC connections with providers that require `client_secret_post` (e.g. JumpCloud) and accept arrays for the `aud` claim:

- `PATCH /api/v2/connections/:id` now preserves existing secret fields (`client_secret`, `app_secret`, `twilio_token`) when the request body omits them, matching Auth0's "missing = keep existing" contract. GET responses strip these, so a read→edit→PATCH round-trip from the admin UI no longer silently wipes them.
- The upstream OAuth2 token exchange in `ExtendedOAuth2Client` now handles both `client_secret_basic` and `client_secret_post` directly (instead of falling through to arctic for Basic) and surfaces the raw upstream response body in thrown errors so `invalid_client` failures from providers like JumpCloud are diagnosable from logs.
- `idTokenSchema.aud` now accepts a string or an array of strings, per OIDC Core §2.
