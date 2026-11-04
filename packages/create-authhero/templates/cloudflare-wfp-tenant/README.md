# AuthHero — WFP Tenant Worker

The full `authhero` app for **one tenant**, deployed into a Workers-for-Platforms
dispatch namespace. It reads only its **own D1** and inherits the control
plane's config (shared social logins, prompts, branding, system resource
servers, inheritable hooks) from rows the **control plane syncs** into that
database.

This is one of three pieces:

| Piece | Template |
| --- | --- |
| Front door (host → tenant → dispatch) | `cloudflare-wfp-dispatcher` |
| **This tenant Worker** | `cloudflare-wfp-tenant` |
| Control plane (config source + management) | `cloudflare-control-plane` |

## How it works

`src/index.ts` is `createWfpTenantApp` from `@authhero/cloudflare-adapter/wfp`.
It layers the data adapter:

```
D1 → keyed encryption (tenant key + "cp" key) → withRuntimeFallback(control_plane)
```

`withRuntimeFallback` resolves the control-plane rows that a sync wrote into this
database under the `control_plane` tenant id. **No request-time call to the
control plane.**

It also mounts the receivers the control plane pushes to, authenticated with
`WFP_INTERNAL_SYNC_SECRET`:

| Route | Used by |
| --- | --- |
| `POST /internal/sync-config` | the `sync-defaults` operation |
| `POST /internal/detach` | the `detach` operation |
| `POST /internal/sync-defaults` | the provisioning seed |

## Variables and secrets

Variables (`[vars]` in `wrangler.local.toml`), set per tenant and fixed for the
life of the script:

- `ISSUER` — this tenant's issuer, with a trailing slash. Tokens carry it as
  `iss`, so do not change it once the tenant has issued any.
- `TENANT_ID` — this tenant's id. A push addressed to another tenant is refused.
- `CONTROL_PLANE_TENANT_ID` — the control plane's tenant id (`control_plane`).
- `CONTROL_PLANE_ISSUER` — the control plane's issuer.

Secrets (`.dev.vars` locally, `--secrets-file` when deployed; never in the
database):

- `ENCRYPTION_KEY` — this tenant's own secrets.
- `CONTROL_PLANE_ENCRYPTION_KEY` — the shared `cp` key. Decrypts the synced
  secrets (e.g. Google `client_secret`). It must be **byte-identical** to the
  control plane's, or a sync is refused with `422 sync_config_key_ring` and
  nothing is written.
- `WFP_INTERNAL_SYNC_SECRET` — must equal the control plane's, or a push answers
  `401`.

## Setup

`create-authhero` has already written `wrangler.local.toml` and `.dev.vars`
(with generated keys). `npm run setup` never overwrites them.

```bash
npm install
# replace CONTROL_PLANE_ENCRYPTION_KEY and WFP_INTERNAL_SYNC_SECRET in .dev.vars
# with the control plane's values, and set [vars] in wrangler.local.toml
npm run migrate          # apply schema to this tenant's D1 (local)
npm run dev
```

## Deploy into the namespace

One Worker per tenant, with its own D1:

```bash
npx wrangler d1 create tenant-<id>-db         # set database_id in wrangler.local.toml
npx wrangler d1 migrations apply AUTH_DB --remote --config wrangler.local.toml
npm run copy-assets
npx wrangler deploy --config wrangler.local.toml \
  --dispatch-namespace=authhero-tenants --name=tenant-<id>-auth \
  --secrets-file .dev.vars
```

`wrangler secret put` cannot target a dispatch namespace, which is why the
secrets go in `--secrets-file`.

A Worker in the namespace cannot carry a cron, so remove any `[triggers]` from
`wrangler.local.toml`.

## Sync

Once the Worker and its D1 exist, run the control plane's `sync-defaults`
operation for this tenant, dry run first:

```http
POST /api/v2/tenants/<id>/operations
{ "kind": "sync-defaults", "input": { "dry_run": true } }
```

Then follow the
[migration runbook](https://docs.authhero.net/customization/multi-tenancy/config-sync-migration).
See also [Control Plane Defaults](https://docs.authhero.net/customization/multi-tenancy/control-plane-defaults).
