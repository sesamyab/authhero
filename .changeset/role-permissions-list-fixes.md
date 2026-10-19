---
"@authhero/drizzle": patch
"@authhero/kysely-adapter": patch
---

Fix `rolePermissions.list`: the drizzle adapter now honors `page`/`per_page` (it previously returned every permission), and the kysely adapter joins resource servers on `identifier` so `resource_server_name` is resolved correctly.
