---
"authhero": minor
---

Emit the `amr` claim (`["mfa"]`) in the ID token after a completed TOTP or SMS MFA challenge, and omit it when no MFA was performed. The factors used are recorded on the login session.
