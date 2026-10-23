---
"@authhero/adapter-interfaces": minor
"authhero": minor
---

Record the management API caller on logs under `details.request.auth` (user, strategy, token `jti` and scopes), like Auth0. The top-level `user_id` stays the target, the caller's token scopes are no longer copied into the top-level `scope`, and log streams now use the same target `user_id` as the logs table.

Access tokens issued by the authorization-code/refresh/etc. flows now include `azp` (the calling client) and a unique `jti`, so management API logs can record `client_id` and the token id.

Management API logs also get `details.request.channel`: the caller's `Origin` (e.g. the admin UI) for browser calls, otherwise `"api"`.
