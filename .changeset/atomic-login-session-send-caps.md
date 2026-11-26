---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"authhero": patch
---

Make the per-login-session send caps atomic. `LoginSessionsAdapter` gains an optional `updateIfStateDataUnchanged` (compare-and-swap on `state_data`), implemented by the kysely, drizzle and aws adapters. The login OTP cap (`LOGIN_OTP_MAX_SENDS`) and the MFA SMS cap (`MFA_MAX_SMS_SENDS`) now reserve their slot through it, so concurrent requests on one login session can no longer exceed them. Adapters without the method keep the previous best-effort behaviour.
