---
"authhero": minor
---

Remove the `/u/check-account` (and `/u2/check-account`) interstitial screen. When an existing session is found at `/authorize`, the auth flow now silently issues a new authorization response (Auth0-compatible SSO) instead of asking the user to confirm "continue as X".

Callers that want to force a fresh login still have the same escape hatches:

- `prompt=login`
- `prompt=select_account` (treated as `prompt=login`; authhero is single-session per browser)
- `screen_hint=login`

The `check-account` route, screen definition, `CheckEmailPage` component, and locale strings have been removed.
