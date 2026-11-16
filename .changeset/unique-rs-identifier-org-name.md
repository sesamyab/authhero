---
"@authhero/drizzle": minor
"@authhero/kysely-adapter": patch
"@authhero/adapter-interfaces": minor
"authhero": patch
---

Enforce resource-server identifier and organization name uniqueness per tenant at the storage layer (#1589).

- `@authhero/drizzle`: migration `0020_resource_server_org_unique` adds unique indexes on `resource_servers (tenant_id, identifier)` and `organizations (tenant_id, name)`, matching the kysely schema. The migration fails if a tenant already has duplicates; resolve them before deploying. Resource-server create/update and organization update now throw a 409 on a unique violation.
- `@authhero/kysely-adapter`: resource-server create/update and organization update throw a 409 on a unique violation instead of a raw driver error.
- `@authhero/adapter-interfaces`: new `isUniqueViolation(err)` that recognizes unique/primary-key violations from SQLite, D1, MySQL, PlanetScale and Postgres drivers, including drizzle-wrapped errors.
- `authhero`: `PATCH /api/v2/organizations/:id` returns 409 `organization_conflict` when the new name belongs to another organization, and `PATCH /api/v2/resource-servers/:id` returns 409 `resource_server_conflict` when the new identifier is taken. The duplicate checks on create and update, and resource-server lookup by identifier, now compare exactly across all pages instead of the first page of a substring search. Unique violations from a concurrent write map to the same 409 bodies.
