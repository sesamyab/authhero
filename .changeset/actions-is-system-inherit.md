---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
---

Add `is_system` and `inherit` flags to actions so the control-plane tenant can publish shared action templates that other tenants opt into.

- **`is_system: true`** on an action in the control-plane tenant marks it as a shared template.
- **`inherit: true`** on a tenant's action makes it a stub: at execute time the code-hook loader reads `code` from the control-plane action whose `name` matches. The local row still owns per-tenant state (enabled/disabled bindings, secrets), and **local secrets override upstream by name** so customers can configure per-tenant credentials without forking the code.
- Edits to the control-plane action propagate live to every inheriting tenant (read-through semantics; no copy-on-install).

Linkage is by **name match** (tenant stub `name == control_plane.name && is_system`), which keeps the "manage by hand in the UI" workflow simple — the operator creates both rows with the same name. No seeder yet; that can come later once the patterns settle.

Schema: two new integer columns on `actions` (`is_system`, `inherit`), backfilled to `0` so existing rows behave exactly as before. The drizzle adapter still has a stub actions adapter that throws — no schema change there.

Runtime read-through requires `data.multiTenancyConfig.controlPlaneTenantId` to be set (it already is when adapters are wrapped via `withRuntimeFallback`). When unset, `inherit: true` falls back to the local `code` so single-tenant deployments don't break.
