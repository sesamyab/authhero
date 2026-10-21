---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"@authhero/multi-tenancy": minor
---

Add the schema for tenant config inheritance: `tenants.parent_tenant_id` and the publishing fields `scope` (local/shared/platform), `override` (none/secrets/fields) and `enforce` on connections, actions, hooks, resource servers, branding, prompt settings and email providers. All columns are nullable and unset reads as today's behaviour; existing `is_system` rows and hooks flagged `metadata.inheritable` are backfilled to `scope: shared`. Nothing reads the fields yet. `parent_tenant_id` is validated for existence, cycles and a maximum depth of 2 when a tenant is created or updated through the multi-tenancy tenants routes.
