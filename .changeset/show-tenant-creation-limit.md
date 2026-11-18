---
"@authhero/multi-tenancy": minor
"@authhero/admin": minor
---

Show a user their own tenant-creation limit. `GET /tenants/creation-limit` returns `{ key, used, limit, source }` for the caller (`limit: null` is unlimited; `source` is `override`, `default` or `none`). The admin shows "2 of 3 tenants used" next to Create in the tenants list and in the create form, and says so when the limit is reached.
