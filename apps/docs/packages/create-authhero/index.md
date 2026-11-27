---
title: Create AuthHero CLI
description: The create-authhero CLI scaffolds a new AuthHero project from one of seven templates — local SQLite, Cloudflare Workers, Workers for Platforms, AWS SST, or a reverse proxy.
---

# Create AuthHero

`create-authhero` scaffolds a ready-to-run AuthHero project. It copies a template, installs dependencies, runs the database migrations and starts the dev server — each step can be skipped.

```bash
npm create authhero@latest my-auth-app
# or
pnpm create authhero my-auth-app
# or
npx create-authhero my-auth-app
```

No global install is needed. The generated projects require Node.js 20.6 or later (the `local` template runs with `--env-file`).

## Templates

| Template | What you get |
| --- | --- |
| `local` | Node.js server on SQLite (Drizzle). Serves HTTPS on `https://localhost:3000` with a self-signed certificate. The quickest way to try AuthHero. |
| `cloudflare` | Cloudflare Worker on D1 (Drizzle), with optional GitHub CI workflows. |
| `cloudflare-wfp-dispatcher` | Workers for Platforms dispatcher: a thin worker that routes custom domains to per-tenant workers in a dispatch namespace. |
| `cloudflare-wfp-tenant` | Workers for Platforms tenant worker: one AuthHero worker with its own D1, inheriting defaults from the control plane. |
| `cloudflare-control-plane` | Workers for Platforms control plane: tenant management and the config source synced into each tenant worker. Always multi-tenant. |
| `aws-sst` | AWS Lambda on DynamoDB, deployed with SST. |
| `proxy` | Host-based reverse proxy on Cloudflare Workers (`@authhero/proxy`), configured statically with no database. |

The three Workers for Platforms templates are deployed together; see [Cloudflare Workers for Platforms](/deployment/cloudflare-wfp).

## Next steps

- [Usage](./usage) — what the interactive setup asks and what it runs
- [Commands](./commands) — every option, for scripted use
- [Your first login](/first-login) — sign in to the scaffolded server
