---
"@authhero/multi-tenancy": patch
---

`POST /tenants` refuses an id that differs from an existing tenant's only in letter case (409). An organization name reaches a token in lowercase and is matched against the tenant id ignoring case, so two such tenants cannot be told apart by their members' tokens: a member of `ACME` would also pass for `acme`. An identical id is still refused by the adapter as before, and existing tenants are not touched.
