---
title: Built-in Adapters
description: Overview of AuthHero's built-in database and platform adapters — Drizzle, Kysely, AWS (DynamoDB) and Cloudflare.
---

# Built-in Adapters

AuthHero ships with several adapter implementations. The database adapters implement the full `DataAdapters` interface; the Cloudflare adapter adds platform services on top of one of them.

## Drizzle (SQL) — Recommended

The primary SQL adapter, built on Drizzle ORM:

- SQLite and Cloudflare D1
- Schema-first approach with pre-generated migrations shipped in the package
- Used by every `create-authhero` template with a SQL database (all except `aws-sst`, which uses DynamoDB, and `proxy`)

```typescript
import createAdapters from "@authhero/drizzle";
const dataAdapter = createAdapters(drizzleDb);
```

[Drizzle adapter details →](/customization/drizzle/)

## Kysely (SQL)

A SQL adapter built on the Kysely query builder, maintained for existing deployments (new projects should prefer Drizzle):

- Tested on SQLite and MySQL (PlanetScale); PostgreSQL is not supported
- Migrations run from code with `migrateToLatest`

```typescript
import createAdapters from "@authhero/kysely-adapter";
const dataAdapter = createAdapters(kyselyInstance);
```

[Kysely adapter details →](/customization/kysely/)

## AWS (DynamoDB)

A DynamoDB adapter for serverless deployments on AWS Lambda:

- Single-table design on DynamoDB
- Used by the `aws-sst` template

[AWS adapter details →](/customization/aws-adapter/)

## Cloudflare

Platform services for Cloudflare Workers. It is not a database adapter — combine it with the Drizzle adapter on D1:

- Custom domains through Cloudflare for SaaS
- Caching through the Workers Cache API
- Branding uploads stored in R2
- Logs and statistics in Analytics Engine or R2 SQL
- Rate limiting through the Workers Rate Limiting binding
- Workers for Platforms tenant provisioning

[Cloudflare adapter details →](/customization/cloudflare-adapter/)
