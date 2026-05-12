---
"authhero": patch
---

Fix management-api writes not invalidating the cache used by u2/auth-api/universal-login/saml. The management-api was always constructing its own `createInMemoryCache(...)` (and on every request), so cache-wrapper invalidation ran against an isolated empty cache while the other apps continued serving stale entries from the shared `config.dataAdapter.cache` for up to 300s. The most visible symptom was toggling client flags such as `hide_sign_up_disabled_error` or `disable_sign_ups` not taking effect on the login flow until the TTL aged out. Management-api now reuses `config.dataAdapter.cache` when provided so writes invalidate the same cache other apps read from, and the fallback in-memory adapter is hoisted out of the per-request middleware.
