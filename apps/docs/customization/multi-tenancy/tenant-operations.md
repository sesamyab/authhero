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

- **`input.dry_run`** computes the diff and writes nothing. **`input.force`** applies even when the tenant's stored hash matches. Other kinds take no `input`.
- **History:** the operation has a `sync-defaults` step with a `started` and a `succeeded` (or `failed`) event, and appears in `GET /tenants/{id}/operations?kind=sync-defaults`.
- **Result:** `result` holds `status` (`applied`, `up-to-date` or `dry-run`), the content `hash`, per-entity counts (`added`, `changed`, `unchanged`, `deleted`, `errors`) and `changes`, the list of `entity:key` that were or would be changed. It never contains row content or secrets.
- **Failure:** if any row reports an error, or the push to the tenant fails, the operation ends `failed` with `error` set, the `result` still shows what happened, and the request returns the failed operation row (`201`) instead of a server error. The tenant's stored hash is only updated by a fully successful run.
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

## Roadmap

Later phases add per-tenant durable upgrades, fleet rollouts (waves + canary + health gate over the `rollouts` table), and D1 Time Travel backups — see [issue #1026](https://github.com/markusahlstrand/authhero/issues/1026).
