---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/multi-tenancy": minor
"@authhero/aws-adapter": patch
---

Choose the universal login per tenant. The new tenant flag `flags.universal_login_version` (`"2"` → `/u2`, `"1"` or unset → `/u`) sets the default for a tenant's applications, and `client_metadata.universal_login_version` (`"2"` or `"1"`) still overrides it per application. Unset tenants behave as before, so no data migration is needed. New tenants created by `seed` or the multi-tenancy `POST /tenants` get `"2"`. Adds a `login-migration` CLI (`count`, `check`, `flip`, `rollback`) for moving tenants to `/u2`. `CreateTenantParams` now accepts `flags`, and the DynamoDB adapter stores flags passed on create (it dropped them before, including flags from multi-tenancy `tenantDefaults`).
