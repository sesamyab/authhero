---
"authhero": patch
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"@authhero/cloudflare-adapter": patch
---

Tighten `/api/v2/stats/daily` and `/api/v2/stats/active-users` to match Auth0's semantics.

**`logins` no longer over-counts.** All three stats adapters (kysely, drizzle, cloudflare/analytics-engine) now count only `s` (SUCCESS_LOGIN) as a login. Previously they also summed token exchanges (`seacft`, `seccft`, `sepft`, `sertft`) and silent auth (`ssa`), which inflated the figure substantially for SPAs that refresh tokens frequently. Auth0's daily-stats `logins` is just successful logins, so the numbers now line up.

**`leaked_passwords` matches Auth0's definition.** Adapters now sum only `pwd_leak` (breached-password detection). The authhero-internal `signup_pwd_leak` and `reset_pwd_leak` variants are no longer included in this metric.

**`/stats/active-users` only counts real logins.** Same narrowing — distinct users with a `SUCCESS_LOGIN` in the last 30 days, not distinct users who happened to exchange a refresh token.

**Zero-fill in `/stats/daily`.** The route now returns one row per day in the requested range, including days with no events (Auth0 behavior). Previously consumers got gaps for empty days, breaking graphs that iterate the array sequentially.
