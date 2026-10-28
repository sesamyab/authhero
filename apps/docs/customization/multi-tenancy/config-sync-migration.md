---
title: Migrating a Tenant to Synced Config
description: A step-by-step runbook for moving one tenant from read-time inheritance to a synced copy of its parent's config, with verification and a rollback window.
---

# Migrating a Tenant to Synced Config

This is the procedure for taking **one tenant** from `inherit-on-read` (config merged in from the control plane on every request) to `synced` (the tenant reads only its own database). Do it for a pilot tenant first, then use [fleet rollouts](./tenant-operations.md#fleet-rollouts-of-synced-config) for the rest.

Background: [per-tenant sync mode](./runtime-fallback.md#per-tenant-sync-mode-config-sync), [syncing a resolved parent chain](./control-plane-defaults.md#syncing-a-resolved-parent-chain) and [shadow mode](./runtime-fallback.md#shadow-mode-for-config-inheritance).

## Before you start

**Pick the pilot.** A tenant you can afford to look at closely: real traffic, but a tenant whose owner you can reach. Prefer one with a Workers for Platforms worker if that is where you are heading, since that exercises the dispatch transport.

**Checklist.** Every item must be true before step 1.

- The control plane has the tenant operations adapters (`GET /api/v2/tenants/{id}/operations` answers) and a `sync-defaults` executor. For a tenant with its own worker and database, `syncDefaults: createDispatchSyncConfig({...})` is passed to `initMultiTenant`.
- `WFP_INTERNAL_SYNC_SECRET` is set to the same value on the control plane and the tenant worker. A mismatch answers `401`.
- The tenant worker has `TENANT_ID` set (a push for another tenant is refused with `403 sync_config_tenant_mismatch`).
- The tenant worker has `CONTROL_PLANE_ENCRYPTION_KEY`, so it can decrypt secrets the control plane encrypted. Without it the push stops with `422 sync_config_key_ring` and nothing is written.
- [Shadow mode](./runtime-fallback.md#shadow-mode-for-config-inheritance) (`inheritanceShadow`) is on for the host that serves the pilot's traffic. It runs where the fallback adapter runs; it is **not** active in a tenant worker, so a pilot that is served only by its own worker cannot be compared that way. In that case rely on the dry run and the smoke tests below.
- The tenant is on the parent you intend: check `parent_tenant_id` (empty means the control plane).
- You hold a **control-plane token**. Only the control plane can change `config_sync`.

**Know what is not synced.** Look at these before the dry run, because the sync will not change them:

- Email provider and branding have no id to mark a synced copy by, so a row the tenant already has is only replaced when the parent locks it (`override: none` or `enforce`). Otherwise it stays, and a later edit on the parent does not reach the tenant. Prompt settings follow the same rule, and are applied only when locked.
- A connection's `enabled_clients` is not copied (it holds the parent's client ids). When a synced connection is **first added**, it is enabled on the tenant's clients that list their connections explicitly; clients without a list already use every connection. Later syncs leave the tenant's choice alone, so enable or disable it per client afterwards if you want something else.
- A row the tenant already has with the same strategy and name (connections), identifier (resource servers) or name (actions) **wins**: no synced copy is added next to it, and the dry run lists `skip entity:key (the tenant has its own)`. Rename or remove one side if you want the parent's row instead.
- `inherit: true` action stubs only resolve against the control plane while the tenant is `inherit-on-read`, and client URLs from the control plane's client are no longer merged once it is `synced`. Copy what the tenant needs into the tenant itself.
- Platform-scoped rows are copied so they can run, but are hidden from the tenant's management API.

## 1. Dry run

```http
POST /api/v2/tenants/{id}/operations
{ "kind": "sync-defaults", "input": { "dry_run": true } }
```

Read `result`: `status` (`dry-run`), per-entity counts (`added`, `changed`, `unchanged`, `deleted`, `errors`) and `changes`, the list of `entity:key` that would change. It shows **which** rows change, never their content or secrets, so there is no field-level diff; compare content on the control plane if a row looks surprising.

Expect `added` for everything the tenant inherited. Investigate:

- any `errors`;
- `skip ... (the tenant has its own)` lines (a name collision from the list above);
- anything you did not expect to be published (check its `scope` on the control plane).

The same preview is in the admin UI on the tenant's **Operations** page (_Preview sync_).

## 2. Sync with inheritance still on

Run the operation without `dry_run`. The tenant is still `inherit-on-read`, so nothing changes for its users yet: the synced rows exist, and read-time inheritance still serves requests.

The operation must end `succeeded`. If it ends `failed`, read `error` and the `failed` event in `GET /operations/{id}`; the tenant's stored hash is only updated by a fully successful run, and retrying is safe. A partial run leaves the rows it applied in place.

## 3. Verify

Do all of these before flipping.

1. **Status.** `GET /api/v2/tenants/{id}/config-sync` shows `drifted: false` and equal `config_sync_hash` and `expected_hash` (the admin UI shows this as _In sync_).
2. **Shadow.** Let the pilot take normal traffic, then look for differences between what read-time inheritance would give and what the synced config gives:

   ```http
   GET /api/v2/logs?q=type:cfgdiff
   ```

   with the pilot's `tenant-id`. An empty result after a representative period is the pass criterion. Each entry names the `kind` (`missing`, `extra`, `changed`), entity and key, never content. Shadow is sampled and rate-limited, so absence is evidence over time rather than proof, and `extra` entries for hooks can be noise from the synced copies: confirm them against the hook list.

3. **Smoke tests.** Log in with each connection the tenant uses, request a token for each resource server, trigger each inherited hook, and confirm each hook runs **once**.

## 4. Flip

```bash
curl -X PATCH https://auth.example.com/api/v2/tenants/settings \
  -H "authorization: Bearer $CONTROL_PLANE_TOKEN" \
  -H "tenant-id: $TENANT" -H "content-type: application/json" \
  -d '{"config_sync": "synced"}'
```

Or **Settings → Advanced** in the admin UI. The instance that handles the request drops its remembered mode at once; every other instance notices within the mode cache time: 10 seconds by default, or the `configSyncCacheTtlMs` you set in `initMultiTenant`. Wait that time plus a margin before judging the result. If the auth server runs with a cache, logins can take longer: the client bundle (the tenant's client, connections and settings) is kept for 5 minutes and may be served up to 10 minutes more while it refreshes, and purging it on a tenant update is best effort. On such a deployment give the flip up to 15 minutes, or purge the cache, before the smoke tests.

Then repeat the smoke tests from step 3. The tenant now reads only its own database.

## 5. Watch, and keep the rollback window

For at least a few days (pick the length with the tenant's owner), watch:

- `GET /logs?q=type:cfgdrift` for the tenant: a drift entry means the parent changed and the tenant has not been brought up to date. With the [scheduled handler wired](./tenant-operations.md#what-starts-a-rollout), a rollout fixes it; otherwise run a `sync-defaults` operation.
- The tenant's operations history (`GET /tenants/{id}/operations?kind=sync-defaults`) for failed runs.
- Login and hook error rates for the tenant, as you would for any release.

**Rollback.** Set `config_sync` back to `inherit-on-read` (same call as the flip). Read-time inheritance resumes. Know what stays behind:

- The synced rows (`sy` ids) remain in the tenant. They are not removed.
- An inheritable hook is not run twice: the original is skipped when the tenant holds its synced copy.
- Changes made on the control plane while the tenant was `synced` are not applied to the copies. Run `sync-defaults` again (it still works in `inherit-on-read`) if you want them current.
- The copies stay read-only to the tenant's admin, according to their `override` and `enforce`.

Do not delete the synced rows by hand during the window; it makes a later re-sync add them back.

## Success criteria

The pilot is migrated when: the sync ended `succeeded`, `drifted` is `false`, the shadow comparison showed no unexplained difference, the smoke tests pass in `synced` mode, and the watch period ended with no regression. Record the date, the operation id and what you found, then move on to [a rollout](./tenant-operations.md#fleet-rollouts-of-synced-config) for the next tenants, starting with a canary.

## Not supported yet

- **Re-parenting.** Changing `parent_tenant_id` of a synced tenant changes the hash, and the next sync adds the new parent's rows and updates shared ones. Rows only the old parent published stay behind until you run a sync with `prune` (preview it first). To leave a parent for good, [detach](#detaching-a-tenant) the tenant instead.
- **Detaching a tenant with its own database.** The `detach` operation works on tenants that share the control plane's database. A tenant with its own worker and database (`deployment_type: "wfp"`) has no transport for it yet.
- **Automatic delete propagation.** A row removed or unshared on the parent is removed from a synced tenant by a sync with `prune` (_Remove unshared_ on the tenant's Operations page), never by a plain sync. A preview always lists what would go.

These are tracked as follow-up issues of the [config inheritance epic](https://github.com/sesamyab/authhero/issues/1524).

## Detaching a tenant

A synced tenant leaves its parent with a `detach` [tenant operation](./tenant-operations.md) (_Detach_ on the tenant's Operations page). Run _Preview detach_ first: it lists every row as `convert`, `remove` or `skip` and writes nothing.

- **Keep (the default).** The copies a sync delivered become the tenant's own rows: the content is kept, the ids are normal, and `scope`, `override` and `enforce` are dropped, so nothing locks them. Hooks run the converted code, and the tenant's clients and organizations that used a copied connection use the new row.
- **Clean (`clean: true`).** The copies are removed instead, platform rows included, and the clients' connection lists are cleaned up. The tenant keeps only its own rows.
- **Platform rows** (`scope: "platform"`) run for the tenant but are hidden from its admins. Converting them would expose their code and secrets, so a plain detach keeps them as copies and reports `skip ... (platform: stays a copy)`. Only `clean` removes them.
- **The tenant** gets `config_sync: "detached"`, no parent and no sync state. It no longer inherits, and `sync-defaults`, rollouts and the drift check leave it alone. To attach it again, set `config_sync` and `parent_tenant_id` back and run a sync.

Rows are created before the copies they replace are removed, but the operation is not atomic: if it fails part-way the tenant is not marked detached, and a retry can leave a duplicate of a row that was already converted, so review the list afterwards. SCIM configurations that point at a copied connection are not moved. Connection order on a client's login page is not kept for converted connections.
