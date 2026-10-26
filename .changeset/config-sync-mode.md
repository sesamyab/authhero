---
"@authhero/multi-tenancy": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"authhero": minor
"@authhero/admin": minor
---

Add a per-tenant `config_sync` mode (`inherit-on-read`, the default, or `synced`). In `synced` mode the runtime fallback adapters, system resource server scopes, client URL merging, inherited actions and control-plane service tokens read only the tenant's own database. The mode is looked up through one shared resolver with a 30 second per-isolate cache, exposed as `multiTenancyConfig.resolveControlPlane` even when the host passes none. Only a control-plane credential can change it (`403` for a tenant's own admin, unchanged values are accepted so the admin UI can round-trip the record); it can be set in the admin UI under Settings → Advanced. Shadow mode skips synced tenants. New nullable `tenants.config_sync` column (kysely migration, drizzle `0014`).
