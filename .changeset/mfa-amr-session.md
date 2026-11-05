---
"authhero": minor
---

Keep the `amr: ["mfa"]` ID token claim for the rest of a session that completed MFA: it is now also emitted on ID tokens from refresh tokens, silent auth and SSO hops, based on the MFA recorded on the browser session.
