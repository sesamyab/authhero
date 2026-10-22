---
"authhero": minor
---

Render prompt partials on the login screens (`login-id`, `login-password`, `login`) and merge `signup-id` / `signup-password` partials into the signup screen. Login screens enforce the stored `ulp-*` constraints and expose the submitted fields to post-login hooks as `event.request.body`.
