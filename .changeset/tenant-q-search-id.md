---
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"@authhero/aws-adapter": patch
---

Tenant list free-text search (`q`) now matches the tenant id (slug) as well as friendly_name. The AWS adapter now implements `q` filtering.
