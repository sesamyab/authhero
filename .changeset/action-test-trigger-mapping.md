---
"authhero": patch
---

Fix `POST /api/v2/actions/actions/:id/test` returning `Unknown trigger: post-login`. The endpoint now maps the Auth0-style `post-login` trigger id to the internal `post-user-login` before invoking the code executor, matching the mapping already applied by the trigger-bindings routes.
