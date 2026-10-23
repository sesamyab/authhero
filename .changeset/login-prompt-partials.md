---
"authhero": minor
"@authhero/admin": minor
---

Prompt partials now work on the login screens (`login-id`, `login-password`, `login`) the same way as on signup, and `signup-id` / `signup-password` partials are merged into the signup screen. Login enforces the stored `ulp-*` constraints, keeps the submitted fields on the login session across steps, passes them to post-login hooks as `event.request.body`, and applies the stored `data-authhero-map` targets to the user when login completes. The admin Partials tab now offers the new prompts, grouped under Login and Sign up.
