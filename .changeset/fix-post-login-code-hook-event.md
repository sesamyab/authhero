---
"authhero": patch
---

Fix `event.client` and other Auth0-shape fields being undefined inside post-user-login code hooks. The code-hook path was constructing a minimal `{ ctx, user, request, tenant }` event while the `ctx.env.hooks.onExecutePostLogin` path right above it was already building the full Auth0-compatible event (`client`, `connection`, `transaction`, `session`, `organization`, `authentication`, `authorization`, `stats`, `resource_server`). Both paths now share the same event, so user-authored actions can access `event.client.name`, `event.connection`, etc. — matching Auth0. Code hooks are now skipped when prerequisites (client/authParams/loginSession) aren't available, instead of running with a broken event.
