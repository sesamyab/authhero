---
"create-authhero": minor
---

Wire config sync into the Workers for Platforms templates, so a control plane can push its inherited config to tenants that have their own Worker and D1.

- **`cloudflare-control-plane`**: the `sync-defaults` tenant operation now reaches WFP tenants through the new `DISPATCHER` dispatch namespace binding and `createDispatchSyncConfig` (tenants that share the database are still synced in-process). The adapters are created with `controlPlane: true`, so `POST /api/v2/tenants/{id}/operations` is mounted, and the control plane tenant's rows are encrypted under the `cp` key id so tenants can decrypt what a sync copies. The tenant-operation and rollout tables are applied with `db:migrate:control-plane:local|remote`, a second migration set tracked in its own table, and `migrate` runs both. This replaces the `buildTenantAdapters` stub and the `POST /internal/tenants/:id/sync-defaults` route, which answered 501 until implemented. `database_name` is now `authhero-platform-db`, as in the Workers for Platforms guide.
- **`cloudflare-wfp-tenant`**: the Worker is built with `createWfpTenantApp`, which adds `/internal/sync-config`, `/internal/detach`, the key ring and the runtime fallback, and runs the inheritance shadow check. It reads `ISSUER`, `TENANT_ID`, `CONTROL_PLANE_TENANT_ID` and `CONTROL_PLANE_ISSUER` from `[vars]` instead of the request, and `ALLOWED_ORIGINS` replaces echoing the request origin. `@authhero/cloudflare-adapter` is now a dependency and `src/app.ts` is gone.
- **Secrets**: `.dev.vars` now also gets a generated `WFP_INTERNAL_SYNC_SECRET`. It and `CONTROL_PLANE_ENCRYPTION_KEY` must be the same on the control plane and every tenant Worker.
- **`npm run setup`** no longer overwrites an existing `wrangler.local.toml` or `.dev.vars`. It used to replace the keys `create-authhero` had just generated, and any ids already entered.
