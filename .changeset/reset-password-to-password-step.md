---
"authhero": patch
---

After a password reset in the u2 flow, send the user straight to the password step with a "password reset" confirmation instead of the identifier screen. Previously a tenant with both code and password connections could land on the OTP step right after setting a new password.
