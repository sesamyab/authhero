---
"@authhero/cloudflare-adapter": patch
---

The Analytics Engine stats and analytics adapters now count events instead of stored rows. `stats.getDaily` (logins, signups, leaked passwords) and every event-count resource in `analytics.query` sum `_sample_interval` in place of `count()` / `SUM(CASE WHEN … THEN 1 …)`, so `/api/v2/stats/daily` and `/api/v2/analytics/*` no longer under-count once Analytics Engine samples a high-volume dataset. Distinct-user metrics (`stats.getActiveUsers`, the `active-users` analytics resource) can't be weighted this way; they are now documented as approximate (a lower bound) under sampling.
