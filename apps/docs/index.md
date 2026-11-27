---
title: Documentation
description: AuthHero documentation — guides, architecture, features, standards, deployment and API reference for the open-source, Auth0-compatible identity platform.
aside: false
prev: false
---

# AuthHero documentation

AuthHero is an open-source, multi-tenant identity platform with Auth0-compatible APIs. It runs on Cloudflare Workers, Node.js, Docker or AWS, against Drizzle (SQLite/D1), Kysely or DynamoDB. These docs cover running, extending and operating it. For the product overview, see [authhero.net](https://authhero.net).

<BookPromo />

## Start here

| I want to…                                    | Read                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Try AuthHero locally                          | [Getting Started](/getting-started) → [Your First Login](/first-login)                                                                                     |
| Understand how it is put together             | [Architecture overview](/architecture/) → [The AuthHero Package](/architecture/authhero-package)                                                           |
| Put it in production                          | [Deployment](/deployment/) → [Cloudflare Workers](/deployment/cloudflare) or [Docker](/deployment/docker) → [Custom domains](/deployment/custom-domain-setup) |
| Move off Auth0                                | [Auth0 Comparison](/auth0-comparison/) → [Lazy Migration](/auth0-comparison/lazy-migration) → [Bulk User Import](/auth0-comparison/bulk-user-import)       |
| Run AuthHero for many customers (SaaS)        | [Multi-Tenant SaaS](/features/multi-tenant-saas) → [Multi-Tenancy Package](/customization/multi-tenancy/)                                                  |
| Customize login or plug in my own logic       | [Actions](/features/actions), [Forms](/features/forms), [UI Widget](/customization/ui-widget/), [Adapter Interfaces](/customization/adapter-interfaces/)    |
| Call the APIs                                 | [API Reference](/api/overview) and [Endpoints](/api/endpoints)                                                                                            |
| Check which specs are supported               | [Standards](/standards/) and [Conformance Testing](/standards/conformance)                                                                                 |
| Contribute to AuthHero                        | [Development Setup](/contributing/development-setup)                                                                                                       |

## Quick start

::: code-group

```bash [npm]
npm create authhero@latest my-auth-app
cd my-auth-app
npm run dev
```

```bash [pnpm]
pnpm create authhero my-auth-app
cd my-auth-app
pnpm dev
```

```bash [docker]
git clone https://github.com/markusahlstrand/authhero.git
cd authhero
docker compose up --build
```

:::

See [Getting Started](/getting-started) for what each option sets up.

## All sections

<DocsMap />
