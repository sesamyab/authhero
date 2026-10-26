# Design: hierarchical tenant config inheritance and fleet sync

- **Status:** Design. Nothing implemented yet.
- **Author:** Markus Ahlstrand
- **Created:** 2026-10-13
- **Related:** `docs/design` tenant lifecycle operations (issue #1026), control-plane
  defaults rollout (`packages/multi-tenancy/src/rollout/`), runtime fallback
  (`packages/multi-tenancy/src/middleware/settings-inheritance.ts`), encrypted data adapter
  (`packages/authhero/src/adapters/createEncryptedDataAdapter.ts`)

---

## 1. Summary

Today there is one global control plane. Tenants inherit its connections, `is_system`
resource servers and `inheritable` hooks **on read**, by querying the control-plane
database at request time. Code actions inherit through an `inherit: true` stub row.

That does not survive the move to Workers for Platforms (WFP): a tenant worker with its
own D1 cannot read the control-plane database per request. It also does not cover what we
want the platform to be:

- A SaaS (Sesamy) manages a fleet of tenants and pushes updates to them.
- Some of Sesamy's tenants use Sesamy as their subscription server and should inherit;
  others should not.
- A customer with a couple of their own tenants can share config between them.
- We, the platform owner, can change defaults for everyone.
- This applies to settings, connections (e.g. Google client secrets) and actions.
- Some actions must never be visible to the child tenant, only runnable.

This document proposes: a **tenant tree** with a nearest-first parent chain, **per-row
publishing properties**, **push-based sync** into each tenant's own database, run as a
**durable, staged fleet operation** on the existing tenant-operations machinery, and a
**per-tenant switch** so tenants migrate from read-time inheritance to synced config one
at a time.

## 2. Goals and non-goals

### Goals

1. A tenant has an optional parent; the chain is at most 2 levels deep to begin with, but
   the model and code do not hard-code the limit.
2. A parent decides, per row, whether it is local, shared with children or platform-only,
   and what a child may override.
3. Changes are **pushed** to children durably, with retry, history and staged rollout.
4. A tenant's runtime reads only its own database once it is on synced config.
5. Migration is gradual, tenant by tenant, with a rollback at every step.
6. Connection secrets travel encrypted. The key ring already in the env settings is
   reused.

### Non-goals

- Child-to-parent propagation. Config flows downwards only.
- Subscribing/pulling as the primary model. Pushing is chosen because the fleets are
  operated by the parent. A pull option can be added later for third-party customers.
- Cross-tenant data (users, sessions). Config only.
- Realtime sync. Eventual consistency in seconds to minutes is fine.

## 3. Model

### 3.1 Tenant tree

```
platform (AuthHero operator)        global defaults
  └─ sesamy (SaaS fleet owner)      fleet defaults + platform-only actions
       └─ publisher-x               customer's own shared config
            ├─ publisher-x-prod
            └─ publisher-x-staging
```

- `tenants.parent_tenant_id` (nullable). No parent means no inheritance, which is the
  current "opted out" case.
- The chain for a tenant is its ancestors, nearest first. A resolver returns it
  (generalising today's `resolveControlPlane`, which returns one tenant).
- Cycles are rejected on write. Depth is validated against a configurable maximum
  (default 2).

### 3.2 Per-row publishing properties

Applies to connections, actions, hooks, resource servers and the singleton settings
(branding, prompt settings, email provider).

| Property   | Values                          | Meaning                                                                                                                      |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scope`    | `local` / `shared` / `platform` | `local`: not published. `shared`: visible to children, who may copy or override it. `platform`: hidden and locked, run only. |
| `override` | `none` / `secrets` / `fields`   | What a child may change on a `shared` row. `secrets` lets a child supply its own client secret.                              |
| `enforce`  | boolean                         | A child cannot disable or delete the row.                                                                                    |

`scope: shared` plus `override: none` is today's `is_system` / `inheritable`. Existing
flags map onto the new fields during migration, so current behaviour does not change.

### 3.3 Resolution

- Rows merge by a stable key: action `name`, connection `name`/`strategy`, resource server
  `identifier`, hook by `(trigger_id, name)`.
- **Nearest wins** for the same key, subject to the parent's `override`.
- **Hooks and actions add up.** A platform hook on `post-user-login` runs in addition to
  the child's own hooks and is not replaced silently.
- **Secrets are layered.** The parent supplies the shared secret and the child's value
  wins when `override` allows it. This is how `loadCodeForHook` merges secrets today.
- The result is **materialised** into the child's database (section 4). The runtime does
  not merge at request time for tenants on synced config.

### 3.4 Visibility of platform rows

Once a row is in the tenant database, hiding it means redacting it, because the tenant's
management API reads that same database.

- `scope: platform` rows are filtered out of the child's management API: list, get by id,
  and hook/action references.
- Code and secrets are never returned for them, even to tenant admins.
- The executor still loads them directly from the database.
- `enforce` and `override` are checked by the existing `protect-synced` middleware, which
  today only knows `is_system`.

Implementation notes (#1497): a copy is recognised by its **id** (the `sy` marker that a
sync derives), so the control plane's own `platform` rows, which it publishes, stay visible
to it. Hidden rows answer 404 like rows that do not exist, and operators (control-plane
credentials) still see them. Inline hook runners in the management API read an unfiltered
stack so platform hooks keep running. Per-row key ids were left out: decryption is
ring-wide and action code is not encrypted, so they would not change what a worker or
database reader can see.

Limit: the code and the (encrypted) secrets are stored in the tenant's database. This
protects against the tenant's admin API. It does not protect against someone with access
to the worker environment or the D1 database. State this in the user docs.

An alternative for the most sensitive actions, executing them on the control plane and
shipping only a reference, is deliberately **not** in scope. It adds a cross-service call
to the login path. It can be added per action later without changing this model.

### 3.5 Secrets

- Connection and action secrets are stored encrypted in the child database using the
  existing `KeyRing` (`ENCRYPTION_KEY`).
- Ciphertext is tagged with a key id and decryption selects the key from the id in the
  ciphertext, so the sync can copy ciphertext as-is. The child's worker environment must
  hold the key ring entry for any key id it receives.
- `resolveEncryptKeyId(tenantId)` can use a different key id for `platform` secrets, so a
  tenant operator without that key cannot decrypt them through the admin API.
- Secrets never appear in operation params, events or logs. Operation params already
  exclude secrets by contract.

## 4. Sync

### 4.1 Push, as an operation

A new `sync-defaults` operation kind on the tenant-operations machinery
(`TenantOperationKind`, `enqueueTenantOperation`, executors, reconciler).

- `buildControlPlaneDefaultsPayload` is generalised to resolve a tenant's parent chain and
  include actions and hooks with their scope and override fields.
- `applyControlPlaneDefaultsPayload` stays the apply side: idempotent upserts keyed by
  stable key, create-if-missing for FK seeds.
- The payload carries a content hash. The tenant stores the hash it last applied, so a
  push to an up-to-date tenant is a no-op.
- Deletes are explicit entries in the payload, and are off by default for the first
  rollouts.

### 4.2 Fan-out and staging

- A parent change enqueues one fleet operation with a `rollout_id`, which enumerates the
  child tenants that are on synced config and subscribed to the changed entity types.
- Each child is its own operation (and its own Workflows instance), so one failure does
  not block the rest.
- Staging: a canary of 1 tenant, then a configurable percentage, then the rest. The
  rollout pauses when the failure rate crosses a threshold.
- Depth: a change at the platform level reaches grandchildren by each level re-syncing its
  own children after it applies an update, so every hop uses the same code path.

### 4.3 Triggers

1. **On write**: management-API writes on a publishing row enqueue a sync through the
   outbox/enqueue hook.
2. **Reconcile**: a periodic job compares each synced tenant's applied hash with its
   chain's current hash and enqueues what has drifted. This is the safety net for lost
   triggers.
3. **Manual**: an API and admin UI action to sync one tenant or a whole subtree.

### 4.4 Drift

If a child edited a `shared` row beyond what `override` allows, the push either skips the
field and records a drift event, or overwrites it when `enforce` is set. Drift is
reported, not silently resolved.

## 5. Migration, tenant by tenant

The new behaviour is off by default and switched per tenant. Each step is additive and
shippable on its own.

1. **Schema.** Add `parent_tenant_id` and the row fields as nullable columns whose
   defaults equal today's behaviour. Control-plane tables go in the control-plane
   migration set, row-level fields in the tenant set, for kysely, drizzle and the WFP
   tenant migrations. Nothing reads them yet.
2. **Shadow mode.** The new resolver computes the merged result for every tenant and is
   compared with what read-time inheritance returns. Differences are logged. The result
   is not used.
3. **Per-tenant mode.** `config_sync: "inherit-on-read" | "synced"`, default
   `inherit-on-read`. A tenant moving to WFP flips it as part of its migration. In `synced`
   mode the runtime fallback reads only the local database.
4. **Dry run.** `sync-defaults` supports `dry_run`, returning the diff (add, change,
   delete) without writing. Operators review before the first real run.
5. **Migrate one tenant**: sync with read-time inheritance still active, verify with the
   shadow comparison, flip to `synced`, keep the fallback for a rollback window. Rolling
   back is flipping the mode, since the control plane still holds the data.
6. **Remove read-time inheritance** only after every tenant is `synced` and a full
   release cycle has passed.
7. **Platform scope and actions** come last. Existing `inherit: true` stubs keep working
   in the meantime.

## 6. Permissions

- A user who manages a tenant can edit its publishing properties and choose which
  children it propagates to.
- Nobody can publish into a tenant above their own.
- The platform owner can change platform defaults, which propagate through the tree.
- Children cannot edit locked rows. This is enforced in `protect-synced`, extended with
  `override` and `enforce`.

### 6.1 Relation to control-plane organizations

Access to tenants is already modelled with control-plane organizations: a tenant's team is
a control-plane organization whose `name` equals the tenant id, and its members are
control-plane users (see `TenantMembersBackend`, `org_name` claim pinning, and
`access-control.ts` in `packages/multi-tenancy`). The tree must fit that model rather than
introduce a second access system.

- **The tree and the organizations are separate things.** `parent_tenant_id` describes
  where config comes from. Organization membership describes who may act. They are not
  derived from each other.
- **"Can manage tenant X"** stays "is a member of organization X". "Can publish to the
  children of X" is a permission on X's organization, not implied by membership in the
  child's organization.
- **No implicit access up or down the tree.** A member of a parent's organization does not
  become a member of the children's organizations. Being able to push config into a child
  is carried by the sync operation (service identity), not by the user's token. An
  operator who also needs to edit a child is added to that child's organization.
- **A child's team cannot reach the parent**, which already holds because the
  `org_name` pin only matches the child's own tenant id.
- **Whose permission starts a sync?** A manual sync records the initiating user
  (`initiated_by`). The user needs the publish permission on the parent organization. The
  automated triggers (write hook, reconcile) run as the system.
- **Customers with several tenants** create a parent tenant whose organization holds the
  people allowed to change shared config, which fits the existing invitation flow.
- **WFP shards.** The tenant shard does not hold the organizations; they live on the
  control plane. Checks for "may publish" therefore happen on the control plane, where the
  sync is initiated. The shard only applies a payload it has accepted from a trusted
  control plane issuer, with the same issuer binding as the tenant-members routes.
- **Nested customer trees (platform → Sesamy → customer).** A customer's parent tenant
  lives under Sesamy's tree but is administered by the customer's organization. Which
  organization may attach a tenant under a given parent (a "may adopt children" permission
  on the parent) has to be defined; without it anyone could attach themselves under
  Sesamy's tree and receive its platform config.

## 7. Open questions

0. Whether the "publish" and "attach children" permissions are new scopes on the
   organization (like `controlplane:tenant_members`) or organization roles.

1. Re-parenting or detaching a tenant: leave projected rows as a snapshot (proposed
   default) or remove them. An explicit "clean" option is needed either way.
2. Per-entity-type subscription for a child (e.g. take connections but not actions), or a
   single on/off switch to start with.
3. Whether a pull/subscribe mode is needed for customers who do not want pushes.
4. How action secrets that differ per child are provisioned at scale: set by the parent
   per child, or by the child's own admin.
5. Whether `platform` rows should use a separate key id by default.

## 8. Rollout plan

Tracked in the GitHub milestone "Tenant config inheritance and fleet sync". The issues
follow section 5 and are ordered by dependency.
