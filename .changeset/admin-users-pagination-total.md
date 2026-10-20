---
"authhero": patch
"@authhero/multi-tenancy": patch
"@authhero/drizzle": patch
"@authhero/kysely-adapter": patch
"@authhero/admin": patch
---

Fix list pagination. With `include_totals=true` the management API now follows Auth0: `length` is the number of items on the returned page and `total` is the overall match count (previously `length` carried the overall count and `total` was missing for most lists, e.g. `/users`). The tenants list now reports `total` too, and the drizzle/kysely tenants adapters return their counts under `totals` as the adapter interface specifies. The admin UI reads `total`, so all pages in tables such as users are reachable.
