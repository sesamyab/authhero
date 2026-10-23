---
"@authhero/adapter-interfaces": minor
"authhero": minor
---

Management API (`sapi`) logs now record who made the change in `details.request.auth`, matching Auth0: the calling user (`user_id`, `name`, `email`) for user tokens, and `strategy` plus `credentials` (`jti`, `scopes`) for every bearer-token call. `user_id` still names the affected user. Client-credentials tokens without `azp` now fill the log's `client_id` from the token subject. The caller's token scopes are no longer copied into the top-level `scope`, and log streams now use the same `user_id` as the logs table (the target user for user-scoped operations, not the caller).
