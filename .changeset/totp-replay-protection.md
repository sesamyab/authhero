---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"authhero": patch
---

Reject reuse of a TOTP code within its validity window (RFC 6238 §5.2, #1666). `verifyTOTP` now returns the matched time step instead of a boolean, and the last accepted step is stored on the `totp` authentication method as `totp_last_step`. The MFA login challenge, the login enrollment confirmation and the account-security enrollment all reject a code whose step is not greater than the stored one, so a code that succeeded once fails on a second submit.

Adapters must implement the new `authenticationMethods.consumeTotpStep(tenant_id, method_id, step)`, which records the step in a single conditional update (like `codes.consume`) and returns false on a replay. The kysely, drizzle and aws adapters implement it. Kysely and drizzle add a nullable `totp_last_step` column to `authentication_methods`. Run the migrations before deploying.
