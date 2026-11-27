---
title: Drizzle Adapter
description: AuthHero's primary database adapter, built on Drizzle ORM for SQLite and Cloudflare D1, with pre-generated migrations shipped in the package.
---

# Drizzle Adapter

`@authhero/drizzle` is AuthHero's primary database adapter. It implements the [adapter interfaces](/customization/adapter-interfaces/) with [Drizzle ORM](https://orm.drizzle.team/) and is what the `create-authhero` templates with a SQL database use — all except `aws-sst` (DynamoDB) and `proxy` (no database).

## Supported databases

The adapter is built on Drizzle's SQLite schema, so it runs on SQLite-compatible databases:

| Database | Driver |
| --- | --- |
| SQLite (Node.js) | `better-sqlite3` via `drizzle-orm/better-sqlite3` |
| Cloudflare D1 | `drizzle-orm/d1` |

PostgreSQL and MySQL are not supported by this adapter. For MySQL on PlanetScale, see the [Kysely adapter](/customization/kysely/).

## Installation

```bash
npm install @authhero/drizzle drizzle-orm
npm install better-sqlite3   # for SQLite on Node.js
```

The package exports the adapter factory (default export) and the schema at `@authhero/drizzle/schema/sqlite`.

::: warning The schema is published as TypeScript source
`@authhero/drizzle/schema/sqlite` resolves to a `.ts` file, which plain `node` cannot load from `node_modules`. Run the server with a TypeScript-aware runner such as [`tsx`](https://tsx.is) (the `local` template uses `tsx`), or bundle it (Wrangler does this on Cloudflare Workers).
:::

## Configuration

Create a Drizzle database with the AuthHero schema, then pass the adapters to `init`.

### SQLite on Node.js

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import createAdapters from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";
import { init } from "authhero";

const db = drizzle(new Database("db.sqlite"), { schema });

const { app } = init({ dataAdapter: createAdapters(db) });
```

### Cloudflare D1

```typescript
import { drizzle } from "drizzle-orm/d1";
import createAdapters from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";
import { init } from "authhero";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = drizzle(env.AUTH_DB, { schema });
    const { app } = init({ dataAdapter: createAdapters(db) });
    return app.fetch(request, env, ctx);
  },
};
```

The [Cloudflare deployment guide](/deployment/cloudflare) covers bindings, assets and secrets.

## Migrations

The schema is owned by AuthHero. The migrations are pre-generated and shipped in the package's `drizzle/` directory — apply them, don't generate your own.

### SQLite on Node.js

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const sqlite = new Database("db.sqlite");
migrate(drizzle(sqlite), {
  migrationsFolder: "node_modules/@authhero/drizzle/drizzle",
});
sqlite.close();
```

### Cloudflare D1

Point the D1 binding at the shipped migrations in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "AUTH_DB"
database_name = "authhero"
database_id = "<your-database-id>"
migrations_dir = "node_modules/@authhero/drizzle/drizzle"
```

and apply them with Wrangler:

```bash
npx wrangler d1 migrations apply authhero --local    # local development
npx wrangler d1 migrations apply authhero --remote   # production
```

After upgrading `@authhero/drizzle`, run the migrations again before deploying the new version.

## Using the adapters

`createAdapters(db)` returns a `DataAdapters` object with one adapter per entity. Methods on tenant-scoped entities take the tenant id first. The exceptions are the `tenants` adapter itself (`create` and `list` take only their params, `get`/`update`/`remove` the tenant id), signing keys, which are keyed by `kid`, and `clients.getByClientId`, which resolves a client id to its tenant.

```typescript
const dataAdapter = createAdapters(db);

const user = await dataAdapter.users.get("tenant_456", "auth2|user_123");

const { users } = await dataAdapter.users.list("tenant_456", {
  page: 0,
  per_page: 10,
  q: "john",
});
```

You normally don't call the adapters directly — `init` uses them to serve the Auth and Management APIs. Calling them is useful in seed and migration scripts.

## Transactions

`dataAdapter.transaction(fn)` behaves differently per driver:

- **SQLite (`better-sqlite3`)** — the callback runs inside `BEGIN`/`COMMIT` and is rolled back if it throws. A nested `transaction()` joins the open one behind a `SAVEPOINT`.
- **Cloudflare D1** — D1 rejects interactive `BEGIN`/`COMMIT`, so the callback runs **without** a surrounding transaction. Multi-statement writes inside a single adapter method are still atomic, because the adapter sends them as one `db.batch()`.

## Troubleshooting

- **`no such table` errors** — the migrations have not been applied to this database. Run them as shown above.
- **Errors after upgrading** — a new adapter version usually ships new migrations. Apply them before deploying.
- **Type errors when creating the database** — pass the AuthHero schema: `drizzle(client, { schema })` with `schema` imported from `@authhero/drizzle/schema/sqlite`.
