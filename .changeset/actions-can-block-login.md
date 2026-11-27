---
"authhero": minor
"@authhero/adapter-interfaces": patch
---

Actions can now block a login (#1816):

- `credentials-exchange`: `api.access.deny` stops token issuance. The token request returns 400 and no tokens are signed; before, the execution was logged as canceled but tokens were still issued.
- `post-user-login`: `api.access.deny` fails the login (403 `access_denied`, the login session is marked failed, and a failed-login log is written). `api.idToken.setCustomClaim` and `api.accessToken.setCustomClaim` now add claims to the tokens of that login, including the authorization-code exchange (not refresh-token exchanges). `api.redirect.sendUserTo` and `api.prompt.render` are still not supported, but each call now records an `unsupported_api` error on the execution instead of being dropped silently.
- New `metadata.fail_closed` on `credentials-exchange`, `post-user-login` and `pre-user-registration` hook bindings: an action that times out, fails or throws denies the request (`action_timeout` / `action_failed`) instead of letting it through. The default is unchanged (fail open).
- The post-login action type declarations now use Auth0's `api.access.deny(reason)` signature.
