---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": minor
"@authhero/multi-tenancy": patch
---

Replace the `pre-account-action` trigger with a generic `pre-screen` trigger (AuthHero extension; Auth0 has no pre-login trigger).

`pre-screen` runs before every universal-login screen is shown (`event.transaction.phase: "render"`) and when it is submitted (`"submit"`), on all u2 screens and the classic `/u` pages that have the same screen, including the login screens (identifier, password, passwordless code, signup), password reset, MFA, consent and the account pages. Screens are named with Auth0's Universal Login vocabulary (`login-id`, `login-password`, `reset-password-request`, `mfa-otp-challenge`, ...) plus AuthHero-only names for the account, connect and self-service screens. Actions can continue, `api.redirect.sendUserTo(url, { query })` or `api.access.deny(reason)`. A binding picks its screens in `metadata.screens` (empty = all); render fails open unless the binding sets `metadata.fail_closed`, submit always fails closed. The config callback is `onExecutePreScreen`.

**Removed:** the `pre-account-action` trigger, the `onExecutePreAccountAction` config callback and their types. No tenant used it. The management API now refuses `pre-account-action` with a 400; hooks still stored with it are ignored, and tenant imports and multi-tenancy syncs skip them with a log line. Its operation names live on as `event.operation` in the submit phase.

Replacing a trigger's bindings (`PATCH /actions/triggers/{id}/bindings`) now keeps the hook `metadata` of actions that stay bound, so screen filters and custom-provider message types survive a reorder.
