---
"authhero": patch
---

Limit failed MFA verifications: after 5 bad TOTP or SMS codes on the challenge, login enrollment or account-security enrollment screens the login session fails (`too_many_mfa_failures`, logged as `gd_otp_rate_limit_exceed`) and later codes, even correct ones, are rejected. When `data.rateLimit` is configured each attempt also consumes the `brute-force` scope keyed by user. MFA SMS sends are capped at 5 per login session and consume the same scope per user.
