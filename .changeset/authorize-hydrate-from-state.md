---
"authhero": patch
---

Fix `Missing required parameter: response_type` when the universal-login widget redirects to `/authorize?connection=X&state=Y` for social login.

When `state` matches a non-terminal `loginSession`, `/authorize` now hydrates missing OAuth params (`response_type`, `redirect_uri`, `scope`, `audience`, `nonce`, `response_mode`, `code_challenge`, `code_challenge_method`, `prompt`, `max_age`, `acr_values`, `login_hint`, `ui_locales`, `organization`) from the session's stored `authParams` before validating. Query params still take precedence — only missing values are filled in. This matches Auth0's behavior of treating `state` as sufficient to identify an in-progress flow.
