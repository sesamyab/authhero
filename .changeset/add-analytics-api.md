---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/cloudflare-adapter": minor
---

Add `/api/v2/analytics/*` — richer stats endpoints with filtering, breakdowns, and a ClickHouse-style `{ meta, data }` wire format.

**Five resources** under `/api/v2/analytics/`: `active-users`, `logins`, `signups`, `refresh-tokens`, `sessions`. Each accepts the same shared parameter shape — `from`, `to`, `interval`, `tz`, repeatable `connection`/`client_id`/`user_type`/`user_id` filters, comma-separated `group_by`, plus `limit`/`offset`/`order_by`. Per-resource grouping rules are validated server-side and rejections return a problem+json body with the offending `param`.

**Wire format** is `{ meta, data, rows, rows_before_limit_at_least, statistics }`, identical to Cloudflare Analytics Engine's SQL output, so the response can be passed straight into Recharts, Tremor, ECharts, Observable Plot, or any ClickHouse-speaking BI tool with zero adapter code.

**New `AnalyticsAdapter`** in `@authhero/adapter-interfaces`. Implementations:
- `@authhero/cloudflare-adapter` — `createAnalyticsEngineAnalyticsAdapter`, compiles each query to a single parameterized SQL statement against the Analytics Engine dataset; tenant predicate is injected server-side and never trusted from request input.
- `@authhero/kysely-adapter` and `@authhero/drizzle` — SQL fallbacks against the `logs` table for local dev and tests (`day` / `hour` / `month` intervals; week is rejected). Active-users uses `COUNT(DISTINCT user_id)`.

**Response caching** uses the existing `CacheAdapter` (Cloudflare cache in workers, in-memory locally — no new KV needed). TTL is picked based on how recent the `to` boundary is: 60s for the live window, 5m for last 24h, 1h within yesterday, 24h for older windows. Cache keys are namespaced by `tenant_id` and normalize the query string so semantically-equivalent requests share an entry.

**Guard rails**: `limit` capped at 10000; `interval=hour` rejected for ranges over 30 days; ungrouped queries can't request more than ~50k rows.

**New scope**: `read:analytics` (alongside `auth:read`).

**React-admin**: new `/analytics` page with resource picker, time-range presets, group-by toggles, connection/client filters, line + bar charts, and CSV export.
