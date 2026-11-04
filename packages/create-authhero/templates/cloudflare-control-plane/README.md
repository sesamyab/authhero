# AuthHero — Control Plane Worker

The **management surface and config source** for a Workers-for-Platforms setup.
It manages tenants, serves colocated tenants from the shared database, and
syncs the config a tenant inherits (shared social logins, prompts, branding,
system resource servers, inheritable hooks, actions) into each WFP tenant's own
database.

This is one of three pieces:

| Piece | Template |
| --- | --- |
| Front door (host → tenant → dispatch) | `cloudflare-wfp-dispatcher` |
| Per-tenant Workers | `cloudflare-wfp-tenant` |
| **This control plane** | `cloudflare-control-plane` |

## Syncing a tenant

A sync is a `sync-defaults` **tenant operation**, with history and a dry run:

```http
POST /api/v2/tenants/{id}/operations
{ "kind": "sync-defaults", "input": { "dry_run": true } }
```

For a tenant with its own Worker and D1 (`deployment_type: "wfp"`), the control
plane resolves the tenant's parent chain, and pushes the result through the
`DISPATCHER` dispatch namespace to the tenant Worker's `/internal/sync-config`.
The tenant Worker applies it to its own database. `src/index.ts`
(`buildSyncDefaults`) picks the transport: a dispatch push for WFP tenants,
in-process for tenants that share this database.

Run the dry run first, then the real operation. To move a tenant onto its synced
config and back, follow the
[migration runbook](https://docs.authhero.net/customization/multi-tenancy/config-sync-migration).

Needs, on the **tenant** Worker (see the `cloudflare-wfp-tenant` template):

- `WFP_INTERNAL_SYNC_SECRET` identical to this one (otherwise `401`)
- `CONTROL_PLANE_ENCRYPTION_KEY` identical to this one (otherwise
  `422 sync_config_key_ring`, and nothing is written)
- `TENANT_ID` set to the tenant's id (otherwise a push for another tenant would
  not be refused)

## Encryption

`src/index.ts` uses a key ring. The `control_plane` tenant's rows (the secrets
that get synced) are encrypted under the key id `cp`; everything else under
`ENCRYPTION_KEY`. A sync copies ciphertext as stored, so a tenant can read what
it receives only if it holds the same `CONTROL_PLANE_ENCRYPTION_KEY`. Values
written before the key ring existed stay readable.

## Secrets

- `ENCRYPTION_KEY` — the control plane's own secrets at rest.
- `CONTROL_PLANE_ENCRYPTION_KEY` — the shared `cp` key. Every tenant Worker holds
  the **same** key; keep it byte-identical everywhere.
- `WFP_INTERNAL_SYNC_SECRET` — bearer secret for the push. Same on every tenant.

`create-authhero` generates all three into `.dev.vars`. They are generated per
project, so copy the control plane's `CONTROL_PLANE_ENCRYPTION_KEY` and
`WFP_INTERNAL_SYNC_SECRET` into each tenant's `.dev.vars`.

## Setup

`create-authhero` has already written `wrangler.local.toml` and `.dev.vars`.
`npm run setup` never overwrites them.

```bash
npm install
# local
npm run migrate        # core schema + the control-plane migration set
npm run seed           # seed the control plane tenant + admin
npm run dev
```

Against a remote database, set `database_id` in `wrangler.local.toml` (on both
`[[d1_databases]]` entries, they are the same database), then:

```bash
npm run db:migrate:remote                 # core schema
npm run db:migrate:control-plane:remote   # tenant operations + rollouts
```

The tenant-operation and rollout tables are a second migration set, tracked in
its own table (`d1_migrations_control_plane`), so the two never re-apply each
other. Without it, `POST /tenants/{id}/operations` fails.

The seed script derives the issuer from the URL it is served on. Seeding with
`wrangler dev --remote` stores `http://localhost:8787/`, so set `issuer` in
`src/seed.ts` to the control plane's real URL first.

### Resolving the control plane tenant

A request is matched to a tenant by its host. Hosts under the `ISSUER` apex are
tenant subdomains (`{tenant}.{apex}`) and are never looked up as custom domains.
Unset, `ISSUER` is the request's own host, so the control plane's host is the
apex and no tenant is found for it as soon as the database holds more than one
tenant (every WFP tenant has a row here). Requests then fail with a SQL error
on `tenants.id = ?`.

So set `ISSUER` to an apex that is not this Worker's host, and give the host a
`custom_domains` row for the control plane tenant:

```toml
# wrangler.local.toml
[vars]
ISSUER = "https://token.example.com/"
```

```sql
INSERT INTO custom_domains (custom_domain_id, tenant_id, domain, "primary", status, type, created_at, updated_at)
VALUES ('cd-control-plane', 'control_plane', 'control.example.com', 1, 'ready', 'self_managed_certs', datetime('now'), datetime('now'));
```

The dispatcher never sees this host (it goes straight to this Worker), so the
row does not affect routing. Tokens the control plane issues carry the custom
domain as `iss`; point the tenants' `CONTROL_PLANE_ISSUER` at it.

### Dispatch namespace

The `DISPATCHER` binding in `wrangler.toml` points at the namespace the tenant
Workers live in:

```bash
npx wrangler dispatch-namespace create authhero-tenants   # once
```

## Before production

- **Rollouts across a fleet** (staged, canary, reconcile) are mounted by
  `initMultiTenant`, but nothing in this template ticks them on a schedule. Wire
  the reconcile into `scheduled()` before relying on automatic drift repair. See
  [Tenant operations](https://docs.authhero.net/customization/multi-tenancy/tenant-operations).
- **Retention of tenant databases.** The `scheduled()` handler sweeps only this
  Worker's own D1. Tenant Workers in a dispatch namespace cannot run a cron.

See [Control Plane Defaults](https://docs.authhero.net/customization/multi-tenancy/control-plane-defaults)
for the full architecture and request flows.
