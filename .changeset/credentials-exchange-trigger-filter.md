---
"authhero": patch
---

Token issuance now only runs Actions bound to `credentials-exchange`. Before, every enabled code hook on the tenant (`post-user-login`, `pre-screen`, user lifecycle bindings) also ran as `credentials-exchange` on every token request and recorded a failure. A `fail_closed` binding on another trigger denied every token request.
