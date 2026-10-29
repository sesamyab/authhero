# @authhero/multi-tenancy

## 15.4.0

### Minor Changes

- c88aa0e: Show what a sync changes. The `sync-defaults` result now also carries `rows` (each change as `{entity, key, action}` with `added`, `changed`, `skipped` or `delete`) and a capped `error_messages`, and the tenant Operations page gets a _Config sync changes_ card with the latest preview and sync grouped by entity, plus the same view in an expanded operation. The operations API now accepts `prune` in a sync's input: it was dropped before, so _Remove unshared_ had no effect.
- 2278144: Each isolate now remembers a tenant's `config_sync` mode for 10 seconds instead of 30, so it notices a flip within that time, and `initMultiTenant` takes `configSyncCacheTtlMs` to set it. Logins on a deployment that caches the client bundle can still take up to 15 minutes to follow a flip.
- c0344ca: Verify a tenant's config on demand. `GET /api/v2/tenants/{id}/config-sync/verify` compares a tenant's config with what its parents publish, read-only, and answers `ok` with the differences (`missing`, `extra`, `changed`, `stale`, by entity and key, never content) and errors. A tenant that inherits on read is compared the way shadow mode does; a synced tenant is checked with a sync dry run against its own rows, so a deleted or edited copy shows up although the stored hash matches, and a tenant with its own database goes through the `syncDefaults` transport. The tenant's sync status card gets a _Verify_ button.
- 1485753: Add a `detach` tenant operation: a synced tenant leaves its parent. The copies a sync delivered become the tenant's own rows (or are removed with `clean`), platform rows stay as copies, and the tenant gets the new `config_sync` mode `detached`, no parent and no sync state, so it neither inherits nor is synced again. The tenant Operations page gets _Preview detach_ and _Detach_. `tenants.update` in the kysely and drizzle adapters now clears `parent_tenant_id`, `config_sync_hash` and `config_synced_at` when given an explicit `null`. The tenant has to be `synced` (a tenant that inherits on read would lose what it inherits), email provider, branding and prompt settings are not touched, and a platform email provider stays hidden after a detach. The operation works on tenants in the control plane's database; a transport for tenants with their own database is a follow-up.
- 734eb8e: Detach for tenants with their own database. `createDispatchDetach` (`@authhero/cloudflare-adapter/wfp`) pushes a `detach` to the tenant worker's new `/internal/detach` route, which converts (or with `clean` removes) the synced copies in the tenant's own database. The control plane checks that the tenant can be detached from its own row and marks it detached only when the worker reports a full success. The Workflows executor runs `detach` (`runDetachOperation`), and `detachTenantRows`, `assertDetachEligible`, `markTenantDetached` and `emptyDetachResult` are exported from `@authhero/multi-tenancy`. A `detach` run also drops the remembered sync mode of the instance that ran it.
- cf6d9bf: Hide the inheritance controls on tenants that have nothing below them. The tenant settings (`GET`/`PATCH /api/v2/tenants/settings`) carry a computed `has_children` (and, from the multi-tenancy router, `is_control_plane`). The admin hides the _Publishing_ card on a tenant without child tenants, the _Rollouts_ button when the control plane has none, the _Source_ column of connections, hooks and resource servers on a tenant that has no children, no parent and is not synced, and the _Parent_ and _Config sync_ columns of the tenants list while the control plane is the only tenant. It keeps showing them while the answer is loading or when the server does not send it. The count of child tenants quotes the tenant id in its query, and the AWS adapter now filters a `parent_tenant_id:<id>` query by the parent instead of treating it as free text.
- fe7f43e: Close the sync gaps from the config inheritance epic: a tenant's own connection, resource server or action with the same key now wins instead of getting a synced copy beside it (reported as `skip ...`, and no unique-index error for resource servers), a newly synced connection is enabled on the tenant's clients that list their connections explicitly, and email provider, branding and prompt settings are replaced when the parent locks them (`override: none` or `enforce`).
- 2c2b0f2: Remove synced copies a parent stopped sharing: `sync-defaults` takes `input.prune`, the sync detects stale `sy` rows in the tenant's own database (also over the dispatch transport and `/internal/sync-config`), and a dry run lists them. The tenant Operations page gets a _Remove unshared_ option.
- 461932f: The control plane carries out the team changes that tenants register as requests (issue #1550). `initMultiTenant({ tenantMemberRequests: { getBackend } })` adds the `tenant-members-request` tenant operation, which reads the request from the tenant, runs it against the tenant's team (checking the tenant and that the requester still belongs to it) and answers the request with the outcome. `memberRequests.enqueue` is what the notify endpoint calls, once per request however often it is told, and `memberRequests.reconcile` is the sweep for requests that were never run or whose run failed, which a tenant worker cannot do itself. `createDispatchTenantMemberRequestStore` and `POST /internal/tenant-member-requests` on the tenant worker reach requests in a tenant's own database.

### Patch Changes

- a780679: Name the tenant an inherited row comes from when the origin is not in the tenant's chain, and leave out the Delete button on an enforced inherited row
- 95df4a5: Run config inheritance shadow mode in a tenant worker. `createWfpTenantApp` takes `inheritanceShadow` (`true` or the usual options): after a request is answered, it compares what the projected control-plane rows give the tenant with what its parent chain resolves to, under `ctx.waitUntil` so the Worker keeps it alive, and logs the differences as `cfgdiff` in the tenant's own logs. The shadow reporter now returns the comparison it starts so a host can wait for it.
- Updated dependencies [c88aa0e]
- Updated dependencies [1485753]
- Updated dependencies [820d44f]
- Updated dependencies [cf6d9bf]
- Updated dependencies [02d3f45]
- Updated dependencies [b0b6c22]
- Updated dependencies [5e85ab2]
- Updated dependencies [e8bf02b]
- Updated dependencies [3bcd1d4]
- Updated dependencies [1a9d2a9]
  - authhero@9.27.0
  - @authhero/adapter-interfaces@4.24.0

## 15.3.0

### Minor Changes

- d6e483f: Admin UI for config inheritance. New `GET /api/v2/tenants/{id}/config-sync` (scope `read:tenants`; the control plane for any tenant, a tenant for its own) returns a tenant's parent, sync mode, applied and expected hash, a `drifted` flag, its parent chain and an `inherited` map from the id of each inherited row to the ancestor that published it; `initMultiTenant` wires it and `getConfigSyncStatus` is exported. In the admin: publishing fields (scope, override, enforce) on actions, hooks, connections and resource servers, an inherited-from notice that locks rows whose parent allows no changes, a source column on the lists, parent tenant on create and in settings, a sync status card (with drift and a force sync) on the settings advanced tab and the tenant operations page, and a rollouts page to start, follow, pause and resume fleet rollouts. Setting or changing a tenant's `parent_tenant_id` (on create and `PATCH /tenants/settings`) now requires a control-plane token, like `config_sync`, since the parent decides whose published config a tenant receives; an unchanged value is still accepted.
- 4ead040: Add a per-tenant `config_sync` mode (`inherit-on-read`, the default, or `synced`). In `synced` mode the runtime fallback adapters, system resource server scopes, client URL merging, inherited actions and control-plane service tokens read only the tenant's own database. The mode is looked up through one shared resolver with a 30 second per-isolate cache, exposed as `multiTenancyConfig.resolveControlPlane` even when the host passes none. Only a control-plane credential can change it (`403` for a tenant's own admin, unchanged values are accepted so the admin UI can round-trip the record); it can be set in the admin UI under Settings → Advanced. Shadow mode skips synced tenants. New nullable `tenants.config_sync` column (kysely migration, drizzle `0014`).
- df0cb5b: Add the resolved config block for tenant config sync. `buildResolvedConfigBlock` merges a tenant's parent chain (actions, code hooks with their hook code, connections, resource servers and more) and `applyResolvedConfigBlock` materialises it under the tenant's own id with deterministic row ids, a content hash stored in the new `tenants.config_sync_hash` / `config_synced_at` columns (an up-to-date push is a no-op), a dry run, explicit opt-in deletes and a key-ring check that refuses to write when the tenant cannot decrypt a key id in the payload. The drizzle adapter now honours `importMetadata.id` for actions and hook code. `config_sync_*` is ignored on tenant PATCH.
- bc2fc83: Add staged fleet rollouts of synced config. A `config-sync` rollout syncs every synced tenant below a root as one `sync-defaults` operation per tenant, in waves (a canary, then cumulative percentages), ordered by depth so parents go before children, with a failure-rate health gate that pauses the rollout, resume, and per-wave progress. New management routes `POST/GET /rollouts`, `GET /rollouts/{id}`, `POST /rollouts/{id}/pause|resume` (scopes `read:rollouts`, `create:rollouts`, `update:rollouts`) and a `rollout_id` filter on a tenant's operations. Triggers: management-API writes to actions, hooks, hook code, connections and resource servers record a coalesced rollout request (new `actions`, `hooks` and `hookCode` entity hooks; the entity hook wrapper now passes extra create arguments through), `reconcileConfigDrift` compares each synced tenant's applied hash with its chain's current hash, writes `cfgdrift` logs and starts a rollout for what drifted, and `advanceRollouts` moves open rollouts along from a scheduled handler. `initMultiTenant` returns the `rollouts` deps and accepts a `rolloutExecutor`. The `rollouts` table gains `config` and `paused_reason` (kysely migration, drizzle control-plane `0002`).
- d01fb3d: Hide platform-scoped rows that a config sync delivered into a tenant from that tenant's management API. Actions (with versions and executions), hooks, hook code, connections, resource servers and, for tenants that receive config, the email provider with `scope: "platform"` and a synced id are missing from lists, answer 404 on get/update/delete, cannot be referenced by hooks or bindings, and are left out of tenant exports. The MCP endpoint, which calls these routes, follows. Control-plane credentials still see them, and code hooks that run inline in a management request read an unfiltered stack (`getExecutorData`), so platform hooks keep running. `protect-synced` now also enforces `override` and `enforce` on synced copies of connections, resource servers, actions and hooks, and refuses edits to code copied for a hook. New exports: `isSyncedRowId`, `withPlatformRowsHidden`, `getExecutorData`.
- 938f6eb: Add the `sync-defaults` tenant operation. `POST /tenants/{id}/operations` with `{ "kind": "sync-defaults", "input": { "dry_run": true } }` syncs a tenant's resolved parent-chain config into its database as a tracked operation with step events and history, returns the diff of a dry run in the operation's `result`, and leaves a queryable `failed` row (returned with `201`) when a row or the transport fails. `initMultiTenant` wires an inline executor that syncs tenants sharing the control plane's database in-process; `syncDefaults` takes a transport for tenants with their own database. On Cloudflare, `runSyncDefaultsOperation` runs it as a Workflows instance (the executor now accepts `sync-defaults`), `createDispatchSyncConfig` pushes the resolved block to the new tenant route `/internal/sync-config` (true dry run, key-ring check, no seeds or signing keys), and the reconciler resolves a completed sync correctly. Operation `input` can now be set at creation, the recorder can store a `result`, and an executor binding can list the `kinds` it runs (others answer `501`). The admin UI gets "Preview sync" and "Sync config" actions with the diff shown per operation.

### Patch Changes

- 6669ed1: Make rolling back a synced tenant safer and document the migration. An inheritable control-plane hook is no longer listed twice for a tenant that holds its synced copy of it (for example after flipping `config_sync` back to `inherit-on-read`). Creating a tenant or changing its `config_sync` through the tenants routes now drops the sync mode the runtime remembers for it in that instance (other instances still take up to 30 s); new optional `onConfigSyncChange` on `MultiTenancyConfig`, wired by `initMultiTenant`.
- Updated dependencies [a6b9648]
- Updated dependencies [4ead040]
- Updated dependencies [df0cb5b]
- Updated dependencies [500811d]
- Updated dependencies [bc2fc83]
- Updated dependencies [d01fb3d]
- Updated dependencies [938f6eb]
  - authhero@9.26.0
  - @authhero/adapter-interfaces@4.23.0

## 15.2.0

### Minor Changes

- f69bc42: Add the parent-chain resolver for tenant config inheritance and a shadow mode. `resolveTenantChain` and `mergeConfig` merge a tenant's ancestors (nearest wins, hooks and actions add up, secrets layered, `override` respected). With `inheritanceShadow` enabled on `initMultiTenant` or `createRuntimeFallbackAdapter`, reads start a background comparison against read-time inheritance and log differences as log type `cfgdiff`, queryable per tenant. The result is never used to serve requests.
- 649cf6a: Add the schema for tenant config inheritance: `tenants.parent_tenant_id` and the publishing fields `scope` (local/shared/platform), `override` (none/secrets/fields) and `enforce` on connections, actions, hooks, resource servers, branding, prompt settings and email providers. All columns are nullable and unset reads as today's behaviour; existing `is_system` rows and hooks flagged `metadata.inheritable` are backfilled to `scope: shared`. Nothing reads the fields yet. `parent_tenant_id` is validated for existence, cycles and a maximum depth of 2 when a tenant is created or updated through the multi-tenancy tenants routes.

### Patch Changes

- Updated dependencies [f69bc42]
- Updated dependencies [649cf6a]
- Updated dependencies [19c1394]
- Updated dependencies [a9316c6]
- Updated dependencies [fe91508]
  - @authhero/adapter-interfaces@4.22.0
  - authhero@9.25.0

## 15.1.2

### Patch Changes

- 56a0205: Fix list pagination. With `include_totals=true` the management API now follows Auth0: `length` is the number of items on the returned page and `total` is the overall match count (previously `length` carried the overall count and `total` was missing for most lists, e.g. `/users`). The tenants list now reports `total` too, and the drizzle/kysely tenants adapters return their counts under `totals` as the adapter interface specifies. The admin UI reads `total`, so all pages in tables such as users are reachable.
- Updated dependencies [56a0205]
- Updated dependencies [b5576e2]
- Updated dependencies [406f0b2]
  - authhero@9.24.1

## 15.1.1

### Patch Changes

- 7fe898e: Fix `initMultiTenant` never running its protection of synced entities. It registered the guard on the app after `init()` had mounted the management routes, so Hono never ran it. Child tenants could modify or delete roles and connections synced from the control plane. Resource servers were unaffected, because they have their own check.

  `init()` gains a `managementApiMiddleware` option. It runs inside the management API after authentication and tenant resolution, and before the route handlers. `initMultiTenant` now installs the guard through it. If you set up multi-tenancy by hand with `app.use("/api/v2/*", createProtectSyncedMiddleware())`, that call never ran. Pass the middleware as `init({ managementApiMiddleware: [createProtectSyncedMiddleware()] })` instead.

- Updated dependencies [20528c7]
- Updated dependencies [ee38a67]
- Updated dependencies [7fe898e]
- Updated dependencies [5a1a8f3]
  - authhero@9.22.0

## 15.1.0

### Minor Changes

- de15e05: Fix per-tenant database isolation. The adapters from `databaseIsolation.getAdapters` were replaced by every AuthHero route group with a stack built from the startup `dataAdapter`, so the auth API, universal login, u2, SAML, SCIM and management API read and wrote the shared database instead of the tenant's.
  - `authhero`: new optional `ctx.var.baseData` request variable. When an earlier middleware installs a raw adapter there, every route group composes its per-request stack (and drains the outbox and writes logs) on top of it instead of `dataAdapter` / `managementDataAdapter`.
  - `@authhero/multi-tenancy`: `createDatabaseMiddleware` sets `ctx.var.baseData` and no longer writes to the runtime's `env` object, which Cloudflare Workers share between requests; it puts `data` on a per-request copy instead. The package's own routes and middleware read the adapter stack from `ctx.var.data`, falling back to `ctx.env.data` when mounted outside AuthHero.

  Both packages must be upgraded together for isolation to take effect.

### Patch Changes

- Updated dependencies [de15e05]
- Updated dependencies [48aaf03]
- Updated dependencies [e988384]
- Updated dependencies [2913547]
- Updated dependencies [f91ca54]
  - authhero@9.21.0
  - @authhero/adapter-interfaces@4.19.0

## 15.0.2

### Patch Changes

- b18cb2e: Fix the dead documentation links in the README. They pointed at
  `authhero.net/packages/multi-tenancy/*`, which does not exist; the chapters are
  published at `docs.authhero.net/customization/multi-tenancy/*`.
- Updated dependencies [e5c33c6]
  - authhero@9.11.1

## 15.0.1

### Patch Changes

- 4ff665a: Escape all values interpolated into Lucene `q` filters with `escapeLuceneValue`. Follow-up to the tokenize-before-OR-split fix (#1264): the remaining raw interpolations (emails, usernames, user ids, client ids, linked_to lookups, entity names in the multi-tenancy sync hooks, and the SCIM/DCR lookups) now go through the shared escaping helper, so a value containing whitespace, quotes or `OR` can never widen a query into extra clauses. The kysely resourceServers list's single-clause fast path now unquotes the operand (via `unquoteLuceneValue`) so quoted values keep matching.
- Updated dependencies [2e77d57]
- Updated dependencies [86e991b]
- Updated dependencies [6aaafb4]
- Updated dependencies [c60fee4]
- Updated dependencies [bb9da90]
- Updated dependencies [318af44]
- Updated dependencies [f2f8ff4]
- Updated dependencies [33e4190]
- Updated dependencies [4ff665a]
- Updated dependencies [c86912c]
- Updated dependencies [90b21e4]
- Updated dependencies [6744248]
- Updated dependencies [b775994]
  - authhero@9.10.0
  - @authhero/adapter-interfaces@4.12.0

## 15.0.0

### Major Changes

- 47851c3: **License change: AuthHero is now dual-licensed (AGPL-3.0-only or commercial).**

  The core server and its runtime packages (`authhero`, the database adapters, `saml`,
  `multi-tenancy`, `proxy`, `@authhero/admin`) are now licensed **AGPL-3.0-only**, with
  commercial licenses available. The integration surfaces stay permissive:
  `@authhero/adapter-interfaces`, `create-authhero` (and the apps it scaffolds), and
  `@authhero/widget` are **MIT** — using these packages on their own imposes no AGPL
  obligations on your code. Use of the AGPL-licensed packages remains subject to
  AGPL-3.0-only (or a commercial license).

  Versions published before this release remain available under their original MIT
  terms. See LICENSING.md in the repository for the full model, and CLA.md for the
  contributor agreement that keeps dual licensing possible.

### Patch Changes

- ee69820: Make the global `admin:organizations` org-membership bypass consistent across grants and adapters, and close a related privilege-escalation on the Drizzle adapter (#1198).
  - **Parity across all three org gates.** The refresh-token grant, token-exchange grant, and `calculateScopesAndPermissions` now share one `userHasGlobalOrgAdminPermission` helper. Previously the scopes-permissions gate only checked _role-derived_ global permissions, so a user granted `admin:organizations` **directly** (not via a role) passed the refresh-token gate but was still rejected with 403 once an `audience` was present. All three now honor both directly-assigned and role-derived global permissions, matched against the Management API audience.
  - **Drizzle `userRoles.list` scope fix (privilege escalation).** `list(..., "")` (global / tenant-level roles) guarded on truthiness, so the empty-string scope fell through to "all scopes" and returned the user's roles across _every_ organization. Consumers that read global roles this way — the `admin:organizations` bypass and the `globalRoles` bucket in `calculateScopesAndPermissions` — would therefore apply an **org-scoped** user's role permissions at the tenant level, letting an admin of a single organization mint a token carrying those permissions globally (e.g. listing every organization without any global grant). Only affected Drizzle (SQLite/D1) deployments; Kysely already scoped correctly. `list(..., "")` now filters `organization_id = ""`, matching Kysely and the documented contract (`undefined` = all scopes, `""` = global only, `"<id>"` = that org).
  - **Audience tightening in tenant provisioning.** `@authhero/multi-tenancy`'s global-admin check now requires `admin:organizations` to be granted on the Management API audience, so an identically named permission on an unrelated resource server can no longer masquerade as the global escape hatch.

  Note: this repairs the code paths, but a user must still actually hold `admin:organizations` on a global role/permission (and the tenant must enable `inherit_global_permissions_in_organizations`) to bypass org membership. A "tenant-admin"-style global role that lacks that specific permission is still rejected by design.

- Updated dependencies [2b9e5ca]
- Updated dependencies [57eca12]
- Updated dependencies [47851c3]
- Updated dependencies [ee69820]
- Updated dependencies [f1cbb4c]
- Updated dependencies [a5cb3a3]
- Updated dependencies [177c0a9]
- Updated dependencies [a7cca7b]
  - authhero@9.0.0
  - @authhero/adapter-interfaces@4.3.0

## 14.27.1

### Patch Changes

- c3c4546: chore: apply repo-wide Prettier formatting

  Formatting-only sweep, no behavior change. Generated output (Stencil loader/hydrate,
  drizzle-kit migration metadata, the built tailwind CSS blob) is now listed in
  `.prettierignore` so it is not reformatted on every build, and `lint-staged` runs in
  the pre-commit hook to keep formatting from drifting again.

- Updated dependencies [c3c4546]
- Updated dependencies [089c6d2]
  - @authhero/adapter-interfaces@4.2.1
  - authhero@8.26.1

## 14.27.0

### Minor Changes

- 74f1373: Auto-provision a default/anchor client at tenant creation (issue #1007).

  New tenants now come with a designated interactive default client by construction, so tenant-level flows that need an anchor (e.g. the DCR `/connect/start` consent flow) no longer silently fall back to an arbitrary — possibly M2M — client.
  - New shared `provisionDefaultClients()` helper (exported from `authhero`) creates an interactive first-party "Default App", sets `tenant.default_client_id` to it, and provisions an M2M "API Explorer" client authorized against the Management API. It is idempotent and import-safe: it respects an already-set `default_client_id`, reuses an existing interactive client instead of duplicating, and skips the M2M client when one already exists. The Default App is created with no connections, so all of the tenant's connections are offered at login.
  - Wired into both tenant-creation paths: the `seed`/bootstrap script and the multi-tenancy `afterCreate` provisioning hook (pooled tenants; isolated tenants are seeded via their own database provisioning).
  - `/connect/start` now falls back to the first _interactive_ client (via the new `isInteractiveClient` helper) instead of `clients[0]`, so it never anchors on an M2M client.
  - `PATCH /tenants/settings` now rejects a `default_client_id` that doesn't reference an existing, interactive client (both the management-api and multi-tenancy handlers).
  - Provisioning now recovers from a partial prior run: if the M2M "API Explorer" client exists but its Management API grant is missing (e.g. a run that failed between creating the client and its grant), a re-run restores the grant instead of returning early.

### Patch Changes

- Updated dependencies [74f1373]
- Updated dependencies [2f62e0b]
  - authhero@8.18.0

## 14.26.0

### Minor Changes

- 88f2bf7: Record tenant lifecycle operations and expose them via the management API (issue #1026, phase 1).
  - `@authhero/multi-tenancy` gains an operations module: `runRecordedTenantOperation` wraps `databaseIsolation.onProvision` so every provision writes a `tenant_operations` row with step events (no behavior change — recording is skipped when the adapters are absent and is warn-only on write failure), plus `createInlineExecutor` / `enqueueTenantOperation` implementing the row-first executor contract the Cloudflare Workflows engine plugs into next. `initMultiTenant` wires a default inline executor for `upgrade` operations when `tenantUpgrade` is configured.
  - `authhero` mounts `GET /api/v2/operations/{id}`, `GET/POST /api/v2/tenants/{id}/operations` (new scopes `read:tenant_operations`, `create:tenant_operations`) when the control-plane operations adapters are present, with a new `tenantOperationExecutor` config binding.
  - `@authhero/cloudflare-adapter`'s WFP provisioning hook accepts an optional step reporter and surfaces `provision-resources` / `seed-defaults` boundaries; reporting can never fail a provision.

### Patch Changes

- d8dac78: Add the `@authhero/cloudflare-adapter/workflows` subpath (issue #1026 phase 2): durable provision-as-workflow for WFP tenants on Cloudflare Workflows.
  - `runProvisionOperation` runs the provisioner steps (via the provider-agnostic `TenantProvisionerSteps` contract) as one durable engine step each — with the defaults seed as a retried step _before_ `ready` and a `verify` step that throws until the tenant D1 actually holds signing keys and its tenant row. "Ready over an empty D1" is no longer possible.
  - `createCloudflareWorkflowsExecutor` implements the row-first `TenantOperationExecutor` contract over a structural Workflows binding (no `cloudflare:workers` import in the library; the downstream worker owns the ~10-line `WorkflowEntrypoint` shell — see `entrypoint.example.ts`).
  - `reconcileTenantOperations` sweeps operations stuck in `pending`/`running` whose engine instance died before its terminal write, copying terminal engine states into the control-plane log (run from a `scheduled` handler, at least daily).
  - `createWfpWorkflowProvisioningHook` replaces inline provisioning with a durable enqueue on tenant create; upgrade/deprovision keep delegating to the inline hook. Wire with `databaseIsolation.recordProvisionOperations: false` (new `@authhero/multi-tenancy` flag) since the workflow owns the operation row.

- Updated dependencies [6258d34]
- Updated dependencies [5b50504]
- Updated dependencies [88f2bf7]
- Updated dependencies [7023dd5]
  - authhero@8.15.0
  - @authhero/adapter-interfaces@3.6.0

## 14.25.1

### Patch Changes

- 3b77bf0: Seed the FK-target `tenants` rows into a WFP tenant's database via the defaults
  payload, so a freshly provisioned tenant worker can write — not just read
  (#972).

  A freshly migrated tenant D1 only has the empty `tenants` table the migrations
  create. D1 enforces the `tenant_id -> tenants(id)` foreign key, so every
  tenant-scoped insert (the tenant's own `POST /api/v2/connections`, and the
  projected control-plane defaults keyed under the control-plane tenant id)
  FK-failed with a 500 until those rows existed.
  - `@authhero/multi-tenancy`: `ControlPlaneDefaultsPayload` now carries a
    `tenants` array of minimal (`id` + `friendly_name`) seed rows, gated by a new
    `tenants` flag on `DefaultsPayloadEntities` (default `true`).
    `buildControlPlaneDefaultsPayload` takes an optional `targetTenantId` and
    emits the control-plane tenant row plus the target tenant's own row;
    `applyControlPlaneDefaultsPayload` upserts those rows **first**
    (create-if-missing, so a re-sync never clobbers a tenant's later edits) and
    reports the outcome under `result.tenants`.
  - `@authhero/cloudflare-adapter`: `createDispatchSyncDefaults` passes the target
    tenant id through to the payload build, so a `/internal/sync-defaults` push
    seeds both FK-target rows before applying the defaults.

- Updated dependencies [3b77bf0]
- Updated dependencies [3b77bf0]
  - authhero@8.7.0

## 14.25.0

### Minor Changes

- 02449c8: Add a transport-agnostic control-plane defaults **wire contract** to
  `@authhero/multi-tenancy` for pushing shared state into per-tenant databases
  (e.g. a Workers-for-Platforms tenant's D1):
  - `buildControlPlaneDefaultsPayload(controlPlaneAdapters, controlPlaneTenantId, entities?)`
    reads the control plane's inheritable connections, `is_system` resource
    servers, `inheritable` hooks, email provider, branding, prompt settings, and
    its **public** `jwt_signing` keys into a `ControlPlaneDefaultsPayload`.
  - `applyControlPlaneDefaultsPayload(payload, targetAdapters, controlPlaneTenantId, options?)`
    applies a payload to a tenant adapter, reusing the same idempotent upsert/filter
    path as `projectControlPlaneDefaults` and adding a dedicated signing-key path.

  Signing keys are projected as a first-class but **security-sensitive** entity:
  `pkcs7` (private key) is stripped on build and re-stripped on apply, keys are
  stored with no `tenant_id` (so `listControlPlaneKeys` resolves them for
  verification), and they are create-if-missing by `kid`.

  `authhero` now exports `listControlPlaneKeys`, `resolveSigningKeys`, and
  `resolveSigningKeyMode` so the control-plane key selection has a single source
  of truth reused by the projection.

### Patch Changes

- Updated dependencies [02449c8]
- Updated dependencies [02449c8]
  - authhero@8.5.0

## 14.24.1

### Patch Changes

- c76247b: Fix tenant deletion returning a 500 instead of the real status, and make tenant create/delete authorization symmetric.
  - **Single Hono instance.** The build no longer inlines a second copy of Hono. The Rollup `external` config only matched the bare `hono` package, so the subpath import `hono/http-exception` was still bundled — giving the package its own `HTTPException` class. The host app's `instanceof HTTPException` check then failed and legitimate 401/403/404s surfaced as generic 500s. Subpath exports are now externalized too, so `hono` (and `@hono/zod-openapi`) resolve to the host app's single instance.
  - **Super-admin delete path.** `DELETE /tenants/{id}` now lets a non-org-scoped control-plane token carrying the `delete:tenants` scope (or `admin:organizations`, mirroring the list route) delete any tenant without per-organization membership. Previously a tenant created via the API/UI by a global admin — who is deliberately not added to the tenant's organization by the provisioning hook — became undeletable through the API.

- Updated dependencies [70e2dae]
- Updated dependencies [c76247b]
- Updated dependencies [70e2dae]
  - authhero@8.4.1

## 14.24.0

### Minor Changes

- 51993f6: Add control-plane defaults projection for Workers-for-Platforms tenants, plus keyed (multi-key) encryption at rest.

  WFP tenants run in their own Worker with their own database and cannot read the control plane's database at request time, so runtime fallback has nothing to resolve against. Instead, the control plane's inheritable defaults (connections, `is_system` resource servers, `inheritable` hooks, email provider, branding, prompt settings) are now **projected into each tenant's own database under the control plane tenant id** — the existing `withRuntimeFallback` resolves them with no read-path change.

  `@authhero/multi-tenancy` adds:
  - `projectControlPlaneDefaults(config, targetTenantId)` — idempotent (upsert-by-id) projection of the control plane's defaults bundle into a tenant database.
  - `createDirectRolloutAdapter(config)` returning a `ControlPlaneRolloutAdapter` (`syncDefaults` / `syncDefaultsToTenants`). The adapter is the seam for execution strategy: inline today, swappable for a durable Cloudflare Workflows implementation later without changing callers.

  `authhero` adds keyed encryption so a tenant can hold inherited secrets at rest without being able to decrypt them:
  - The `enc:v1:` field-encryption format gains an optional key id (`enc:v1:<keyId>:<payload>`), fully backward compatible with existing unkeyed values.
  - `createEncryptedDataAdapterWithKeyRing(data, ring, { resolveEncryptKeyId })` encrypts each tenant's secrets under a key selected from a `KeyRing` (e.g. control-plane-tenant rows under a control-plane-only key id), choosing the key on read from the id embedded in the ciphertext.
  - New low-level helpers `encryptFieldWithRing`, `decryptFieldWithRing`, `parseKeyId`, and the `KeyRing` / `EncryptKeyIdResolver` types.

  Existing single-key `createEncryptedDataAdapter` and all current ciphertext are unchanged.

### Patch Changes

- Updated dependencies [51993f6]
  - authhero@8.3.0

## 14.23.1

### Patch Changes

- aedf807: Add a Danger zone to the tenant settings Advanced tab with a confirmation-gated delete button, hide the default delete button at the top of the settings edit page, and fix the access check on `DELETE /tenants/{id}` so tokens carrying an `org_name` claim that matches the target tenant pass without a redundant control-plane membership lookup (which was rejecting valid org-scoped tokens).
- Updated dependencies [aedf807]
- Updated dependencies [aedf807]
  - @authhero/adapter-interfaces@3.1.1
  - authhero@7.2.2

## 14.23.0

### Minor Changes

- dcc6501: Migrate to Zod 4 and `@hono/zod-openapi` v1. The `@hono/zod-openapi` peer dependency now requires `^1.4.0` — consumers must upgrade alongside this release.

### Patch Changes

- Updated dependencies [1fd754b]
- Updated dependencies [dcc6501]
  - authhero@5.9.0
  - @authhero/adapter-interfaces@2.6.0

## 14.22.0

### Minor Changes

- 14a66d6: Remove the `auth:read` / `auth:write` super-scopes. Every management-api route now requires its specific Auth0-style scope (e.g. `read:users`, `create:clients`, `update:connections`). Tokens that previously relied on `auth:read` or `auth:write` must be reissued with the granular scopes for each endpoint they call.

### Patch Changes

- Updated dependencies [667681b]
- Updated dependencies [14a66d6]
  - authhero@5.7.0

## 14.21.0

### Minor Changes

- 063910b: Add a `resolveControlPlane` option to `initMultiTenant` and `withRuntimeFallback` for per-tenant runtime inheritance. The resolver receives `{ tenant_id }` and returns the control plane (`{ tenantId, clientId? }`) to inherit from, or `undefined` to opt that tenant out of inheritance entirely. Mirrors the shape of `signingKeyMode` / `userLinkingMode` in authhero so isolated tenants can be excluded from connection, hook, resource-server, and email-provider fallback without forking the adapter setup.

  Access control, sync direction, and tenant management routing continue to use the static `controlPlane.tenantId` and are not affected by the resolver. Existing static `controlPlaneTenantId` / `controlPlaneClientId` usage is unchanged.

### Patch Changes

- 063910b: Stop merging control-plane client URLs into `clients.get`/`getByClientId` at the adapter layer. The merge previously surfaced inherited `callbacks`, `web_origins`, `allowed_logout_urls`, and `allowed_origins` everywhere the adapter was read — including the management API, which caused the admin UI to display (and on save, persist) URLs that actually belonged to the control-plane client. The URL merge now happens in authhero's `getEnrichedClient` helper, which only auth-flow code paths use; storage reads from the management API and DCR see the tenant's raw stored values.

  The `mergeClientWithFallback` helper is now exported from `@authhero/multi-tenancy` so external runtimes can apply the merge themselves if they bypass `getEnrichedClient`.

- Updated dependencies [063910b]
- Updated dependencies [9a57e8f]
- Updated dependencies [9a57e8f]
  - authhero@5.3.1

## 14.20.3

### Patch Changes

- 85d1d06: Fix `GET /api/v2/tenants` returning 403 for users who only have organization membership (no `read:tenants` or `auth:read` scope). The route now requires authentication only; the handler filters by control-plane organization membership and returns an empty list when the user has no accessible tenants.
- Updated dependencies [85d1d06]
- Updated dependencies [85d1d06]
  - authhero@4.112.0
  - @authhero/adapter-interfaces@1.14.0

## 14.20.2

### Patch Changes

- e79c7d9: Fix tenant-list authorization bypass for org-scoped tokens. `GET /tenants` previously returned every tenant whenever the caller's token carried `admin:organizations` or `auth:read`, but `admin:organizations` is also granted via org-scoped roles — so any organization admin received cross-tenant visibility. The full-access shortcut now only applies when the token has no `org_id` claim, and the route additionally requires the `read:tenants` or `auth:read` scope.

## 14.20.1

### Patch Changes

- 3230b9b: Hook metadata bag + control-plane template inheritance.

  Adds a free-form `metadata: Record<string, unknown>` field to all hook variants (web, form, template, code), persisted as JSON in kysely + drizzle. Two well-known keys are defined:
  - `metadata.inheritable: true` — when set on a hook on the control-plane tenant, the multi-tenancy runtime fallback surfaces that hook on every sub-tenant's `hooks.list` and `hooks.get`. Inherited hooks are read-only from the sub-tenant's perspective: writes go through the base adapter's `tenant_id` WHERE clause and are silent no-ops on cross-tenant rows.
  - Template options. The dispatcher forwards `hook.metadata` to the template function. The `account-linking` template reads `metadata.copy_user_metadata: true` to merge the secondary user's `user_metadata` into the primary's on link (primary wins on key conflicts; `app_metadata` is never copied).

  Includes the kysely migration `2026-04-29T10:00:00_hooks_metadata` adding the `metadata` column.

- Updated dependencies [6ddeedc]
- Updated dependencies [3230b9b]
  - authhero@4.107.0
  - @authhero/adapter-interfaces@1.10.2

## 14.20.0

### Minor Changes

- d288b62: Add support for dynamic workers

### Patch Changes

- Updated dependencies [d288b62]
  - authhero@4.98.0

## 14.19.1

### Patch Changes

- 0a3d5d3: Gate resource server scope inheritance on is_system flag and match by id instead of identifier. Apply scope inheritance to the management API adapter so is_system resource servers show their effective scopes from the control plane.

## 14.19.0

### Minor Changes

- 20d5140: Add support for dynamic code

  BREAKING CHANGE: `DataAdapters` now requires a `hookCode: HookCodeAdapter` property. Adapters implementing `DataAdapters` must provide a `hookCode` adapter with `create`, `get`, `update`, and `remove` methods for managing hook code storage. See `packages/kysely/src/hook-code/` for a reference implementation.

### Patch Changes

- Updated dependencies [20d5140]
  - @authhero/adapter-interfaces@1.0.0
  - authhero@4.91.0

## 14.18.0

### Minor Changes

- f3b910c: Add outbox pattern

### Patch Changes

- Updated dependencies [f3b910c]
  - @authhero/adapter-interfaces@0.152.0
  - authhero@4.82.0

## 14.17.0

### Minor Changes

- 3e74dea: Update handling of host headers

### Patch Changes

- Updated dependencies [3e74dea]
- Updated dependencies [022f12f]
  - @authhero/adapter-interfaces@0.151.0
  - authhero@4.80.0

## 14.16.0

### Minor Changes

- 7c52f88: Fix setup guide bugs

### Patch Changes

- Updated dependencies [7c52f88]
  - authhero@4.76.0

## 14.15.0

### Minor Changes

- 5e73f56: Remove magic strings
- 5e73f56: Replace magic strings

### Patch Changes

- Updated dependencies [5e73f56]
- Updated dependencies [5e73f56]
  - @authhero/adapter-interfaces@0.147.0
  - authhero@4.67.0

## 14.14.0

### Minor Changes

- 7754a80: Create organization

### Patch Changes

- Updated dependencies [30b5be1]
  - @authhero/adapter-interfaces@0.145.0
  - authhero@4.63.0

## 14.13.0

### Minor Changes

- 1a72b93: Added error pages and fixed provider user id

### Patch Changes

- Updated dependencies [1a72b93]
  - @authhero/adapter-interfaces@0.142.0
  - authhero@4.58.0

## 14.12.0

### Minor Changes

- 818846d: Change to use auth0 instead of auth2

### Patch Changes

- Updated dependencies [818846d]
- Updated dependencies [6476145]
  - authhero@4.45.0

## 14.11.0

### Minor Changes

- b1e8715: Inherit scopes instead of syncing

## 14.10.0

### Minor Changes

- 44b76d9: Do not inherit data for the management api

### Patch Changes

- Updated dependencies [44b76d9]
  - authhero@4.29.0

## 14.9.0

### Minor Changes

- d1df006: Add fallback to control plane client

## 14.8.0

### Minor Changes

- a8e70e6: Fix fallbacks for sms service options
- a8e70e6: Update schemas to remove old fallbacks

### Patch Changes

- Updated dependencies [a8e70e6]
- Updated dependencies [a8e70e6]
  - authhero@4.27.0
  - @authhero/adapter-interfaces@0.129.0

## 14.7.0

### Minor Changes

- 8150432: Replaced legacy client

### Patch Changes

- Updated dependencies [fd374a9]
- Updated dependencies [8150432]
  - @authhero/adapter-interfaces@0.127.0
  - authhero@4.23.0

## 14.6.0

### Minor Changes

- 829afab: Hide sensistive info in management api

### Patch Changes

- Updated dependencies [5519225]
- Updated dependencies [829afab]
- Updated dependencies [76510cd]
  - authhero@4.12.0

## 14.5.0

### Minor Changes

- 9d6cfb8: Wrap adapters as part of the multi-tenant package

### Patch Changes

- Updated dependencies [9d6cfb8]
  - @authhero/adapter-interfaces@0.122.0
  - authhero@4.9.1

## 14.4.0

### Minor Changes

- 967d470: Add a metadata field to roles and resource-servers

### Patch Changes

- Updated dependencies [2853db0]
- Updated dependencies [967d470]
- Updated dependencies [8315e5c]
- Updated dependencies [a98dbc4]
- Updated dependencies [58ca131]
  - @authhero/adapter-interfaces@0.121.0
  - authhero@4.8.0

## 14.3.0

### Minor Changes

- d7e8c95: Update dependencies

## 14.2.0

### Minor Changes

- fb3b47e: Remove hard coded control-plane tenant id

### Patch Changes

- Updated dependencies [fb3b47e]
  - authhero@4.1.0

## 14.1.0

### Minor Changes

- 489db0b: Remove the connection sync
  Created a saas multi-tenant guide

## 14.0.0

### Major Changes

- 3d3fcc0: Move logic over to multi-tenancy

### Minor Changes

- 3d3fcc0: Migrate connections

### Patch Changes

- Updated dependencies [3d3fcc0]
- Updated dependencies [3d3fcc0]
  - authhero@4.0.0

## 13.20.0

### Minor Changes

- b7bb663: Make organizations lowercase

### Patch Changes

- Updated dependencies [b7bb663]
  - @authhero/adapter-interfaces@0.118.0
  - authhero@3.6.0

## 13.19.0

### Minor Changes

- 8611a98: Improve the multi-tenancy setup

### Patch Changes

- Updated dependencies [8611a98]
  - @authhero/adapter-interfaces@0.117.0
  - authhero@3.5.0

## 13.18.0

### Minor Changes

- 6dcb42e: Refactor assets

## 13.17.0

### Minor Changes

- 71b01a6: Move authhero to peer dependency

### Patch Changes

- Updated dependencies [71b01a6]
  - authhero@3.3.0

## 13.16.0

### Minor Changes

- 9c15354: Remove shadcn and updated widget

### Patch Changes

- Updated dependencies [9c15354]
  - @authhero/adapter-interfaces@0.116.0
  - authhero@3.2.0

## 13.15.0

### Minor Changes

- 8858622: Move fallbacks to multi-tenancy package

### Patch Changes

- Updated dependencies [63e4ecb]
- Updated dependencies [8858622]
  - authhero@3.1.0

## 13.14.0

### Minor Changes

- 44b751a: Sync connections

## 13.13.3

### Patch Changes

- authhero@3.0.0

## 13.13.2

### Patch Changes

- authhero@2.0.0

## 13.13.1

### Patch Changes

- Updated dependencies [928d358]
  - authhero@1.4.0

## 13.13.0

### Minor Changes

- efaad87: Check for permissions rather than scopes for tenants

## 13.12.1

### Patch Changes

- Updated dependencies [f738edf]
  - @authhero/adapter-interfaces@0.115.0
  - authhero@1.3.0

## 13.12.0

### Minor Changes

- c8c83e3: Add a admin:organizations permission to hande organizations in the control_plane

### Patch Changes

- Updated dependencies [c8c83e3]
  - authhero@1.2.0

## 13.11.0

### Minor Changes

- 17d73eb: Change name of organization flag and add OR support in lucence queries
- e542773: Fixes for syncing resources servers and global roles

### Patch Changes

- Updated dependencies [17d73eb]
- Updated dependencies [e542773]
  - @authhero/adapter-interfaces@0.114.0
  - authhero@1.1.0

## 13.10.1

### Patch Changes

- Updated dependencies [d967833]
  - @authhero/adapter-interfaces@0.113.0
  - authhero@1.0.0

## 13.10.0

### Minor Changes

- aaf0aa0: Fix paging issue for scopes
- aaf0aa0: Update permissions casing

### Patch Changes

- Updated dependencies [aaf0aa0]
- Updated dependencies [aaf0aa0]
  - authhero@0.309.0

## 13.9.0

### Minor Changes

- bbe5492: Add real scopes

### Patch Changes

- Updated dependencies [bbe5492]
  - authhero@0.308.0

## 13.8.1

### Patch Changes

- Updated dependencies [63f9c89]
  - authhero@0.307.0

## 13.8.0

### Minor Changes

- 0f8e4e8: Change from main to control plane
- 3a180df: Fix organization names for main tenant

### Patch Changes

- Updated dependencies [0f8e4e8]
- Updated dependencies [3a180df]
  - authhero@0.306.0

## 13.7.0

### Minor Changes

- aba8ef9: Handle org tokens for the main tenant

### Patch Changes

- Updated dependencies [aba8ef9]
  - authhero@0.305.0

## 13.6.0

### Minor Changes

- 1c36752: Use org tokens for tenants in admin

### Patch Changes

- Updated dependencies [1c36752]
  - authhero@0.304.0

## 13.5.0

### Minor Changes

- b778aed: Seed mananagement roles and create organizations

### Patch Changes

- Updated dependencies [b778aed]
  - authhero@0.303.0

## 13.4.0

### Minor Changes

- 283daf2: Refactor multi-tenancy package
- ae8553a: Add is_system to all adapters

### Patch Changes

- Updated dependencies [283daf2]
- Updated dependencies [ae8553a]
  - authhero@0.302.0
  - @authhero/adapter-interfaces@0.112.0

## 13.3.0

### Minor Changes

- e87ab70: Move tenants crud to multi-tenancy package

## 13.2.0

### Minor Changes

- 9e34783: Sync resource servers for multi tenancy setup

## 13.1.3

### Patch Changes

- Updated dependencies [906337d]
  - @authhero/adapter-interfaces@0.111.0

## 13.1.2

### Patch Changes

- Updated dependencies [a108525]
  - @authhero/adapter-interfaces@0.110.0

## 13.1.1

### Patch Changes

- Updated dependencies [1bec131]
  - @authhero/adapter-interfaces@0.109.0

## 13.1.0

### Minor Changes

- ee4584d: Small update for getting local mode working smoothly

## 13.0.0

### Patch Changes

- Updated dependencies [6929f98]
  - authhero@0.294.0

## 12.0.0

### Patch Changes

- Updated dependencies [85b58c4]
  - authhero@0.293.0

## 11.0.0

### Patch Changes

- Updated dependencies [973a72e]
  - authhero@0.292.0

## 10.0.2

### Patch Changes

- Updated dependencies [0e906aa]
  - @authhero/adapter-interfaces@0.108.0
  - authhero@0.291.2

## 10.0.1

### Patch Changes

- Updated dependencies [212f5c6]
  - @authhero/adapter-interfaces@0.107.0
  - authhero@0.291.1

## 10.0.0

### Patch Changes

- Updated dependencies [5ed04e5]
  - authhero@0.291.0

## 9.0.1

### Patch Changes

- Updated dependencies [f37644f]
  - @authhero/adapter-interfaces@0.106.0
  - authhero@0.290.1

## 9.0.0

### Patch Changes

- Updated dependencies [40caf1a]
  - @authhero/adapter-interfaces@0.105.0
  - authhero@0.290.0

## 8.0.0

### Patch Changes

- Updated dependencies [125dbb9]
  - @authhero/adapter-interfaces@0.104.0
  - authhero@0.289.0

## 7.0.0

### Patch Changes

- Updated dependencies [c51ab9b]
  - authhero@0.288.0

## 6.0.0

### Patch Changes

- Updated dependencies [b0c4421]
- Updated dependencies [c96d83b]
  - @authhero/adapter-interfaces@0.103.0
  - authhero@0.287.0

## 5.0.0

### Patch Changes

- Updated dependencies [65db836]
  - authhero@0.286.0

## 4.0.0

### Patch Changes

- Updated dependencies [e04bae4]
  - authhero@0.285.0

## 3.0.0

### Patch Changes

- Updated dependencies [6952865]
  - authhero@0.284.0

## 2.0.0

### Patch Changes

- Updated dependencies [0566155]
- Updated dependencies [0566155]
  - @authhero/adapter-interfaces@0.102.0
  - authhero@0.283.0

## 1.0.0

### Minor Changes

- 8ab05b4: Add multi-tenancy package

### Patch Changes

- Updated dependencies [8ab05b4]
  - authhero@0.282.0
