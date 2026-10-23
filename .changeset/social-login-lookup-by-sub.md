---
"authhero": patch
---

Find social and enterprise users by their upstream subject (`provider|sub`) before falling back to email + provider. A user whose stored email no longer matched the email from the IdP (for example after editing it) failed to log in with "User already exists (409)".
