---
title: Tenant Operations
description: Durable tenant lifecycle operations (provision, upgrade, backup) with an append-only history, an inline executor, and a Cloudflare Workflows engine.
---

# Tenant Operations

Tenant lifecycle work — provisioning a WFP tenant's D1, seeding its defaults, upgrading its worker bundle — used to run as one-shot imperative sequences: no retries surviving a redeploy, no history of what was attempted, and a failed seed could leave a tenant marked `ready` over an empty database.

Tenant operations (issue #1026) fix this with two pieces:

1. **A control-plane log**: `tenant_operations` (one row per run: kind, status, engine, error, timestamps) and `tenant_operation_events` (append-only per-step history). The tenant row's `provisioning_state` / `worker_version` / `database_version` stay the _current-state snapshot_; operations are the log explaining how it got there.
2. **Swappable executors**: an inline executor that runs steps synchronously, and a Cloudflare Workflows executor that runs the same steps durably with per-step retries. The control-plane database is always the source of truth — the engine is just the executor.

## Data model

The tables are **control-plane only** — they never exist in a WFP tenant's D1:

- **kysely**: shipped in the normal migration chain (kysely only runs control planes).
- **drizzle**: shipped as a separate `drizzle-control-plane/` migration set with its own journal. Apply it _in addition to_ the core set, with a distinct migrations table:

```typescript
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

migrate(db, { migrationsFolder: "node_modules/@authhero/drizzle/drizzle" });
migrate(db, {
  migrationsFolder: "node_modules/@authhero/drizzle/drizzle-control-plane",
  migrationsTable: "__drizzle_migrations_control_plane",
});
```

Then opt the adapter factory in — the adapters' presence is also what mounts the management routes:

```typescript
const adapters = createAdapters(db, { controlPlane: true });
```

## Recording (no behavior change)

When the control plane carries the operations adapters, `createProvisioningHooks` automatically wraps `databaseIsolation.onProvision` so every provision writes an operation row with step events (`provision-resources`, `seed-defaults` when using the WFP hook). Failures are recorded with the error and rethrown — rollback semantics are unchanged, and a deployment without the adapters behaves exactly as before.

## Management API

Mounted only when the operations adapters are present. Scopes: `read:tenant_operations`, `create:tenant_operations`.

| Route                                  | Purpose                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v2/tenants/{id}/operations`  | Paginated history for a tenant (filters: `kind`, `status`)                                                                          |
| `GET /api/v2/operations/{id}`          | One operation plus its full event timeline                                                                                          |
| `POST /api/v2/tenants/{id}/operations` | Enqueue `{ "kind": "upgrade" }` or `{ "kind": "sync-defaults" }` (control-plane only; retry = enqueue again — steps are idempotent) |

Clients poll `GET /operations/{id}` while an operation runs; the inline engine returns it already terminal.

## Syncing a tenant's config (`sync-defaults`)

`sync-defaults` copies the config a tenant inherits (its parent chain, resolved: actions, hooks and hook code, connections, resource servers and more) into the tenant's own database, as a tracked operation. See [syncing a resolved parent chain](./control-plane-defaults.md#syncing-a-resolved-parent-chain) for what is copied and how.

```http
POST /api/v2/tenants/acme/operations
{ "kind": "sync-defaults", "input": { "dry_run": true } }
```

- **`input.dry_run`** computes the diff and writes nothing. **`input.force`** applies even when the tenant's stored hash matches. **`input.prune`** also removes synced copies (`sy` ids) the chain no longer publishes, for example a row the parent stopped sharing; the tenant's own rows are never touched, and a dry run lists them as `delete entity:key` whether or not `prune` is set. Other kinds take no `input`.
- **History:** the operation has a `sync-defaults` step with a `started` and a `succeeded` (or `failed`) event, and appears in `GET /tenants/{id}/operations?kind=sync-defaults`.
- **Result:** `result` holds `status` (`applied`, `up-to-date` or `dry-run`), the content `hash`, per-entity counts (`added`, `changed`, `unchanged`, `deleted`, `errors`) and `changes`, the list of `entity:key` that were or would be changed. It never contains row content or secrets. It also holds `rows`, the same changes as `{entity, key, action}` (`added`, `changed`, `skipped` for a row the tenant has its own of, or `delete` for a copy the parent no longer shares), and `error_messages`, the first 20 row errors cut to 300 characters. Results from before `rows` existed are read from `changes`.
- **Failure:** if any row reports an error, or the push to the tenant fails, the operation ends `failed` with `error` set. When the sync completed and reported row errors, `result` still shows what happened; when the push itself was rejected or unreachable there is no `result`, only the `error` and the `failed` event. The tenant's stored hash is only updated by a fully successful run.
- **What the request returns:** with the inline executor the sync runs in the request, so a failed run comes back as the failed operation row (`201`, `status: "failed"`) instead of a server error. With Cloudflare Workflows the request returns the enqueued operation before the sync runs; poll `GET /operations/{id}` until it is terminal to learn whether it failed.
- **Transport:** tenants that share the control plane's database are synced in-process. A tenant with its own worker and database (`deployment_type: "wfp"`) needs a dispatch transport: pass `syncDefaults: createDispatchSyncConfig({...})` to `initMultiTenant`, which pushes the resolved block to the tenant worker's `/internal/sync-config`. Without it such a tenant's sync fails with a message saying so.
- **Executors:** the inline executor runs it in the request. On Cloudflare Workflows the same `TenantOperationWorkflow` class handles it (`runSyncDefaultsOperation`, branching on the params' `kind`); the instance retries the step a few times, since a sync is idempotent.
- Whether a deployment offers a kind depends on its executor: a request for a kind the executor does not run answers `501`. A deployment without an upgrade handler therefore offers `sync-defaults` only.

## Durable provisioning on Cloudflare Workflows

`@authhero/cloudflare-adapter/workflows` runs the full provision sequence as one durable engine instance per tenant:

```
mark-running → create-database → apply-migrations → upload-script →
upload-secrets → seed-defaults → verify → mark-ready
```

Two steps close the "ready but empty D1" incident class permanently:

- **seed-defaults** is a retried step _before_ `ready` whose per-entity errors fail the operation (not a `console.error`).
- **verify** queries the tenant D1 (via the same REST path migrations use) and throws until it actually holds signing keys and the tenant row — a propagation race becomes a few retried verifies.

The workflow writes back to the operation log inside every `step.do`, so the history is durable too. If an instance dies before its terminal write, `reconcileTenantOperations` (run from the worker's `scheduled` handler — at least daily; engine retention is 30 days) copies the engine's terminal state into the database. A `sync-defaults` instance that completed without throwing is marked `succeeded`; one that errored is marked `failed` with the engine's error.

### Wiring the downstream worker

The deploy repo owns the ~10-line `WorkflowEntrypoint` shell (only it can import `cloudflare:workers`); everything else comes from the library. See `entrypoint.example.ts` in `@authhero/cloudflare-adapter` for the full reference, including `buildProvisionDeps(env)` and the `scheduled` handler.

Tenant create flips from inline provisioning to a durable enqueue:

```typescript
const workflowHook = createWfpWorkflowProvisioningHook({
  tenants: adapters.tenants,
  inline: inlineHook, // upgrade/deprovision stay inline for now
  enqueueOperation: (input) =>
    enqueueTenantOperation(
      stores,
      createCloudflareWorkflowsExecutor({
        binding: env.TENANT_OPERATIONS_WORKFLOW,
      }),
      input,
    ),
});

// databaseIsolation: {
//   onProvision: workflowHook.onProvision,
//   onDeprovision: workflowHook.onDeprovision,
//   recordProvisionOperations: false, // the workflow owns the operation row
// }
```

::: warning Semantic change
With the workflow hook, tenant-create returns while the tenant is still `provisioning_state: "pending"` — the workflow marks it `ready` (or `failed`). Clients must poll the tenant row or the operations API instead of assuming a synchronous `ready`. Any best-effort post-create seed should be deleted; the seed is a durable step inside the workflow.
:::

Rollout order for an existing deployment: apply the control-plane migrations, deploy the worker with both paths available, then flip tenant-create to the workflow hook.

## Fleet rollouts of synced config

A **rollout** syncs the config of every `config_sync: "synced"` tenant below a root tenant as one `sync-defaults` operation per tenant (their `rollout_id` is the rollout's id), in waves:

- **Plan:** tenants are ordered by depth and then id, so a parent syncs before its children (that is how a change reaches grandchildren: each level has its rows in place before the next level's chain is read). Tenants whose applied hash already matches what their chain publishes are left out, unless `force` is set. Each tenant gets a `pending` operation with its wave in `input.wave`.
- **Waves:** a canary (default 1 tenant) goes first, then waves given as cumulative percentages of all planned tenants, canary included (default `10`, `50`, `100`). A wave is only started once the one before it has finished. Without a canary (`canary: 0`) the first percentage wave is wave 0 and gets the failure threshold instead of zero tolerance.
- **Health gate:** when a wave finishes, the canary pauses the rollout on any failure and later waves when the failed fraction exceeds `failure_threshold` (default `0.1`). A paused rollout has `status: "paused"` and a `paused_reason`; nothing further starts. The last wave is checked the same way: if it is unhealthy the rollout ends `failed` with the reason instead of `done`. **Resume** accepts the failures and continues with the next wave; the tenants that failed are found again by the drift reconcile once `retryAfterMs` (default one hour) has passed since their last failed sync.
- **Ticks:** a rollout is advanced by a stateless tick that reads its state from the database, so it survives restarts and can run from several places. Creating a rollout starts the canary immediately; the rest is driven by `advanceRollouts`, which a host calls from its scheduled handler every few minutes. `max_concurrent` (default 25) bounds the operations started per tick.

```http
POST /api/v2/rollouts
{ "root_tenant_id": "main", "canary": 1, "waves": [10, 50, 100], "failure_threshold": 0.1 }

GET  /api/v2/rollouts/{id}          # status plus per-status and per-wave operation counts
POST /api/v2/rollouts/{id}/pause    # { "reason": "..." }
POST /api/v2/rollouts/{id}/resume
GET  /api/v2/tenants/{id}/operations?rollout_id={id}
```

Scopes `read:rollouts`, `create:rollouts` and `update:rollouts`; control-plane only. `dry_run` previews the whole rollout without writing, `tenant_ids` limits it to some tenants, and `root_tenant_id` rolls out to one subtree. A tenant syncs when its operation runs, so a rollout reaches tenants that share the control plane's database through the inline executor and tenants with their own worker through the transport given as `syncDefaults`; pass a Workflows executor as `rolloutExecutor` to run the waves durably.

### What starts a rollout

1. **A write.** After an action, hook, hook code, connection or resource server is created, updated or deleted through the management API, and the row is published (`scope` `shared` or `platform`, or, for rows nobody has annotated, what read-time inheritance already shares), the tenant's change is recorded by creating or touching one pending rollout request. A burst of writes is one request, and the tick plans it once writes have been quiet for `debounce_ms` (default 60 s). A request that finds nothing out of date is removed.
2. **The drift reconcile.** `reconcileConfigDrift` compares every synced tenant's applied hash with the hash its chain would produce now. Drifted tenants get a `cfgdrift` log (queryable per tenant with `GET /logs?q=type:cfgdrift`, with the reason `hash-mismatch` or `never-synced` and both hashes, never row content) and one rollout for the tenants no open rollout already covers and whose latest sync did not fail within `retryAfterMs`. It is the safety net for writes that bypassed the hooks (direct database writes, imports) and for lost requests, and it is idempotent. Email provider and branding changes have no write hook yet and are found this way.
3. **An operator.** `POST /rollouts` (above), or a single tenant with a `sync-defaults` operation.

Wire the two library calls into the scheduled handler, with the `rollouts` value `initMultiTenant` returns:

```typescript
const { app, rollouts } = initMultiTenant({ dataAdapter, controlPlane });

export default {
  fetch: app.fetch,
  async scheduled(_event, env) {
    if (!rollouts) return;
    await reconcileConfigDrift(rollouts); // lost triggers
    await advanceRollouts(rollouts); // next wave of every open rollout
  },
};
```

### Sync status and the admin UI

`GET /api/v2/tenants/{id}/config-sync` (scope `read:tenants`; the control plane can read any tenant, a tenant only its own) reports a tenant's parent and `config_sync` mode, the applied and expected hash, `drifted` (a synced tenant whose stored hash differs from what its chain publishes now), the parent `chain`, and `inherited`, a map from the id each inherited row has in the tenant to the ancestor that published it. It never contains row content or secrets, and `platform` rows are left out.

The tenant's Operations page opens with a _Config sync changes_ card: the latest preview (what the next sync would add, change, keep or remove) and the latest sync (what it did, with its errors), grouped by entity. A preview is a snapshot, so run _Preview sync_ again after changing the parent. The admin app uses it to show where a row comes from ("Inherited from ..."), to lock a row when its parent allows no changes (`override: none`), and to show a sync status card with a drift badge on a tenant's settings and operations pages. Scope, override and enforce are edited in a _Publishing_ card on actions, hooks, connections and resource servers (email provider and branding have no editor yet). The card and the _Rollouts_ button are only shown when there is something below to receive a row: the tenant settings carry a computed `has_children`, and the control plane has children as soon as it is not the only tenant. The _Source_ column on connections, hooks and resource servers is shown only on a tenant that has children, a parent or is synced, and the _Parent_ and _Config sync_ columns of the tenants list only once a tenant has a parent or is synced. The control plane gets a _Rollouts_ page under the tenants list to start, follow, pause and resume rollouts.

Per-entity subscriptions are not supported: a tenant is either `synced` or not.

## Roadmap

Later phases add per-tenant durable upgrades and D1 Time Travel backups — see [issue #1026](https://github.com/markusahlstrand/authhero/issues/1026).
