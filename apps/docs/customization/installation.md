---
title: AuthHero Installation
description: Install the AuthHero package using npm, yarn, or pnpm. Requirements, basic usage, and next steps for configuration.
---

# AuthHero Installation

## Requirements

- Node.js (version 20 or higher; CI-tested on Node.js 22.x)
- npm, yarn, or pnpm package manager

## Installation

Install AuthHero together with a database adapter in your project:

```bash
pnpm add authhero @authhero/drizzle drizzle-orm better-sqlite3 @hono/node-server
```

Or using npm:

```bash
npm install authhero @authhero/drizzle drizzle-orm better-sqlite3 @hono/node-server
```

Or using yarn:

```bash
yarn add authhero @authhero/drizzle drizzle-orm better-sqlite3 @hono/node-server
```

## Basic Usage

Here's a basic example of integrating AuthHero in your application:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { serve } from "@hono/node-server";
import createAdapters from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";
import { init } from "authhero";

const db = drizzle(new Database("db.sqlite"), { schema });
const { app } = init({ dataAdapter: createAdapters(db) });

serve({ fetch: app.fetch, port: 3000 });
```

Apply the database migrations before the first start — see the [Drizzle adapter](/customization/drizzle/#migrations).

## Next Steps

After installation, you'll need to configure AuthHero for your specific use case. See the [Configuration](configuration.md) page for details.
