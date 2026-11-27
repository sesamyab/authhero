---
title: Database Migration Guide
description: Migrate between databases using AuthHero's passthrough adapter. Run dual databases, sync writes, verify data integrity, and switch with zero downtime.
---

# Database Migration Guide

This guide demonstrates how to migrate from one database to another using AuthHero's passthrough adapter system. You'll run both databases in parallel, sync all writes to both systems, verify data integrity, and then switch over with zero downtime.

## Overview

AuthHero's database-agnostic design allows you to:

- **Run multiple databases simultaneously** during migration
- **Sync all writes** to both old and new databases
- **Read from the old database** while building up the new one
- **Verify data integrity** before switching
- **Switch databases** without downtime by changing configuration

## Migration Strategy

The migration process follows these phases:

1. **Setup**: Configure both old and new adapters
2. **Dual-Write**: Write to both databases, read from old
3. **Backfill**: Copy existing data to new database
4. **Verification**: Compare data between databases
5. **Switchover**: Make new database primary
6. **Cleanup**: Remove old database once stable

## Example: MySQL (Kysely) to SQLite (Drizzle) Migration

This example shows migrating from MySQL on PlanetScale (with the Kysely adapter) to SQLite (with the Drizzle adapter). The same steps apply to any pair of adapters.

### Phase 1: Setup Both Adapters

First, install both adapters:

```bash
pnpm add @authhero/kysely-adapter kysely kysely-planetscale @authhero/drizzle drizzle-orm better-sqlite3
```

Create connections to both databases:

```typescript
// src/database.ts
import { Kysely } from "kysely";
import { PlanetScaleDialect } from "kysely-planetscale";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import createKyselyAdapters, {
  type Database as KyselyDatabase,
} from "@authhero/kysely-adapter";
import createDrizzleAdapters from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";

// Old database: MySQL on PlanetScale with Kysely
const mysqlDb = new Kysely<KyselyDatabase>({
  dialect: new PlanetScaleDialect({ url: process.env.DATABASE_URL }),
});

// New database: SQLite with Drizzle (apply the shipped migrations first —
// see the Drizzle adapter page)
const sqliteDb = drizzle(new Database("db.sqlite"), { schema });

// Create adapters
export const mysqlAdapter = createKyselyAdapters(mysqlDb);
export const sqliteAdapter = createDrizzleAdapters(sqliteDb);
```

On Cloudflare Workers the new side is D1 instead: `drizzle(env.AUTH_DB, { schema })` with `drizzle` from `drizzle-orm/d1`. `kysely-planetscale` talks to PlanetScale over HTTP, so the old side works in a Worker unchanged.

### Phase 2: Configure Dual-Write

Use the passthrough adapter to write to both databases:

```typescript
// src/adapters.ts
import { createPassthroughAdapter } from "@authhero/adapter-interfaces";
import { mysqlAdapter, sqliteAdapter } from "./database";

// Track sync errors for monitoring
const syncErrors = new Map<string, number>();

function handleSyncError(entity: string) {
  return (error: Error, method: string, args: unknown[]) => {
    const key = `${entity}.${method}`;
    syncErrors.set(key, (syncErrors.get(key) || 0) + 1);

    console.error(`SQLite sync failed for ${key}:`, {
      error: error.message,
      args: args.slice(0, 2), // Log first 2 args (usually tenantId, id)
    });

    // Send to your monitoring system
    // reportError(error, { entity, method });
  };
}

// Create dual-write adapters for each entity
export const dataAdapter = {
  // Start from the old adapters, so every entity not listed below keeps
  // reading and writing the old database. This must come first: a spread
  // placed after the entries below would override them.
  ...mysqlAdapter,

  // For entities being migrated, use passthrough
  users: createPassthroughAdapter({
    primary: mysqlAdapter.users,
    secondaries: [
      {
        adapter: sqliteAdapter.users,
        blocking: true, // Wait to ensure SQLite write succeeds
        onError: handleSyncError("users"),
      },
    ],
  }),

  tenants: createPassthroughAdapter({
    primary: mysqlAdapter.tenants,
    secondaries: [
      {
        adapter: sqliteAdapter.tenants,
        blocking: true,
        onError: handleSyncError("tenants"),
      },
    ],
  }),

  clients: createPassthroughAdapter({
    primary: mysqlAdapter.clients,
    secondaries: [
      {
        adapter: sqliteAdapter.clients,
        blocking: true,
        onError: handleSyncError("clients"),
      },
    ],
  }),

  // Add all other entities...
  connections: createPassthroughAdapter({
    primary: mysqlAdapter.connections,
    secondaries: [
      {
        adapter: sqliteAdapter.connections,
        blocking: true,
        onError: handleSyncError("connections"),
      },
    ],
  }),

  logs: createPassthroughAdapter({
    primary: mysqlAdapter.logs,
    secondaries: [
      {
        adapter: sqliteAdapter.logs,
        blocking: false,
        onError: handleSyncError("logs"),
      },
    ], // Logs can be non-blocking
  }),

  sessions: createPassthroughAdapter({
    primary: mysqlAdapter.sessions,
    secondaries: [
      {
        adapter: sqliteAdapter.sessions,
        blocking: true,
        onError: handleSyncError("sessions"),
      },
    ],
  }),

  codes: createPassthroughAdapter({
    primary: mysqlAdapter.codes,
    secondaries: [
      {
        adapter: sqliteAdapter.codes,
        blocking: true,
        onError: handleSyncError("codes"),
      },
    ],
  }),

  passwords: createPassthroughAdapter({
    primary: mysqlAdapter.passwords,
    secondaries: [
      {
        adapter: sqliteAdapter.passwords,
        blocking: true,
        onError: handleSyncError("passwords"),
      },
    ],
  }),

};

// Export sync error stats for monitoring
export function getSyncErrorStats() {
  return Object.fromEntries(syncErrors.entries());
}
```

Update your application to use the new adapter:

```typescript
// src/index.ts
import { init } from "authhero";
import { dataAdapter } from "./adapters";

const { app } = init({
  dataAdapter,
  // ... other config
});

export default app;
```

### Phase 3: Backfill Existing Data

List functions return one page at a time — `users.list` returns at most 50 users without pagination parameters — so the scripts below walk every page. Put the walks in a shared module:

```typescript
// scripts/list-all.ts
import type { DataAdapters, Tenant, User } from "@authhero/adapter-interfaces";
import { fetchAll } from "authhero";

// tenants.list has no checkpoint mode; fetchAll walks it with an id cursor.
export function listAllTenants(adapter: DataAdapters) {
  return fetchAll<Tenant>((params) => adapter.tenants.list(params), "tenants", {
    maxItems: -1,
  });
}

// A checkpoint walk (from/take, then follow `next`) returns every primary
// user. Linked accounts — rows with `linked_to` set — are folded into their
// primary user's identities and are not part of the walk.
export async function listPrimaryUsers(adapter: DataAdapters, tenantId: string) {
  const users: User[] = [];
  let from: string | undefined;
  do {
    const page = await adapter.users.list(tenantId, { from, take: 100 });
    users.push(...page.users);
    from = page.next;
  } while (from);
  return users;
}

// The Kysely adapter's offset mode does return linked accounts, so page
// through them with a filter. (The Drizzle adapter never lists them; read
// them one by one with users.get.)
export async function listLinkedUsers(adapter: DataAdapters, tenantId: string) {
  const users: User[] = [];
  const perPage = 100;
  for (let page = 0; ; page++) {
    const result = await adapter.users.list(tenantId, {
      page,
      per_page: perPage,
      q: "_exists_:linked_to",
      sort: { sort_by: "created_at", sort_order: "asc" },
    });
    users.push(...result.users);
    if (result.users.length < perPage) return users;
  }
}
```

Then copy the data from MySQL to SQLite:

```typescript
// scripts/backfill-data.ts
import { mysqlAdapter, sqliteAdapter } from "../src/database";
import { listAllTenants, listLinkedUsers, listPrimaryUsers } from "./list-all";

async function backfillEntity<T>(
  entityName: string,
  items: T[],
  create: (item: T) => Promise<unknown>,
) {
  console.log(`Backfilling ${items.length} ${entityName}...`);

  let successful = 0;
  let failed = 0;

  for (const item of items) {
    try {
      await create(item);
      successful++;

      if (successful % 100 === 0) {
        console.log(`  Migrated ${successful}/${items.length} ${entityName}`);
      }
    } catch (error) {
      failed++;
      console.error(`  Failed to migrate ${entityName}:`, error);
    }
  }

  console.log(
    `✓ Completed ${entityName}: ${successful} successful, ${failed} failed\n`,
  );
  return { successful, failed };
}

async function main() {
  console.log("Starting database backfill...\n");

  // Backfill in dependency order: tenants, then users
  const tenants = await listAllTenants(mysqlAdapter);
  await backfillEntity("tenants", tenants, (tenant) =>
    sqliteAdapter.tenants.create(tenant),
  );

  for (const tenant of tenants) {
    // Primary users first, so linked accounts find the user they point to
    const primaryUsers = await listPrimaryUsers(mysqlAdapter, tenant.id);
    await backfillEntity(`users (${tenant.id})`, primaryUsers, (user) =>
      sqliteAdapter.users.create(tenant.id, user),
    );

    const linkedUsers = await listLinkedUsers(mysqlAdapter, tenant.id);
    await backfillEntity(`linked users (${tenant.id})`, linkedUsers, (user) =>
      sqliteAdapter.users.create(tenant.id, user),
    );

    // Password hashes live in their own adapter; copy each user's current one
    const users = [...primaryUsers, ...linkedUsers];
    await backfillEntity(`passwords (${tenant.id})`, users, async (user) => {
      const password = await mysqlAdapter.passwords.get(tenant.id, user.user_id);
      if (password) await sqliteAdapter.passwords.create(tenant.id, password);
    });
  }
  // Add other entities in correct order

  console.log("Backfill complete!");
}

main().catch(console.error);
```

Run the backfill:

```bash
tsx scripts/backfill-data.ts
```

### Phase 4: Verification

Create a verification script that compares both sides record by record: every id must exist on both sides, and the fields that matter for login must hold the same values. Comparing counts or ids alone would pass a user whose email or password hash differs.

```typescript
// scripts/verify-migration.ts
import type { User } from "@authhero/adapter-interfaces";
import { mysqlAdapter, sqliteAdapter } from "../src/database";
import { listAllTenants, listLinkedUsers, listPrimaryUsers } from "./list-all";

// The user fields that must match. Adapters differ in whether an unset field
// is null or missing, so both count as "unset".
const USER_FIELDS = [
  "email",
  "email_verified",
  "phone_number",
  "phone_verified",
  "username",
  "connection",
  "provider",
  "is_social",
  "linked_to",
  "blocked",
] as const;

function compareRecords<T>(
  entityName: string,
  mysqlRecords: T[],
  sqliteRecords: T[],
  getId: (record: T) => string,
  fields: readonly (keyof T)[],
) {
  console.log(`Verifying ${entityName}...`);
  console.log(`  MySQL: ${mysqlRecords.length} records`);
  console.log(`  SQLite: ${sqliteRecords.length} records`);

  const sqliteById = new Map(sqliteRecords.map((record) => [getId(record), record]));
  const mysqlIds = new Set(mysqlRecords.map(getId));
  const missingInSQLite = [...mysqlIds].filter((id) => !sqliteById.has(id));
  const extraInSQLite = [...sqliteById.keys()].filter((id) => !mysqlIds.has(id));
  const differing = mysqlRecords.filter((record) => {
    const other = sqliteById.get(getId(record));
    return (
      other !== undefined &&
      fields.some((field) => (record[field] ?? null) !== (other[field] ?? null))
    );
  });

  if (missingInSQLite.length > 0) {
    console.error(`  ✗ ${missingInSQLite.length} records missing in SQLite`);
    console.error(`  Missing IDs:`, missingInSQLite.slice(0, 5));
  }
  if (differing.length > 0) {
    console.error(`  ✗ ${differing.length} records differ`);
    console.error(`  Differing IDs:`, differing.slice(0, 5).map(getId));
  }
  if (extraInSQLite.length > 0) {
    console.warn(`  ⚠ ${extraInSQLite.length} extra records in SQLite`);
    console.warn(`  Extra IDs:`, extraInSQLite.slice(0, 5));
  }

  const ok = missingInSQLite.length === 0 && differing.length === 0;
  if (ok) console.log(`  ✓ ${entityName} verified\n`);
  return ok;
}

async function main() {
  console.log("Starting migration verification...\n");
  const results: boolean[] = [];

  const mysqlTenants = await listAllTenants(mysqlAdapter);
  const sqliteTenants = await listAllTenants(sqliteAdapter);
  results.push(
    compareRecords("tenants", mysqlTenants, sqliteTenants, (t) => t.id, [
      "friendly_name",
      "audience",
    ]),
  );

  for (const tenant of mysqlTenants) {
    const [mysqlUsers, sqliteUsers] = await Promise.all([
      listPrimaryUsers(mysqlAdapter, tenant.id),
      listPrimaryUsers(sqliteAdapter, tenant.id),
    ]);
    results.push(
      compareRecords(
        `users (${tenant.id})`,
        mysqlUsers,
        sqliteUsers,
        (user) => user.user_id,
        USER_FIELDS,
      ),
    );

    // The Drizzle adapter doesn't list linked accounts; look each one up
    const linkedUsers = await listLinkedUsers(mysqlAdapter, tenant.id);
    const linkedInSQLite = await Promise.all(
      linkedUsers.map((user) => sqliteAdapter.users.get(tenant.id, user.user_id)),
    );
    results.push(
      compareRecords(
        `linked users (${tenant.id})`,
        linkedUsers,
        linkedInSQLite.filter((user): user is User => user !== null),
        (user) => user.user_id,
        USER_FIELDS,
      ),
    );

    // Password hashes must match exactly, or those users can't log in
    let passwordMismatches = 0;
    for (const user of [...mysqlUsers, ...linkedUsers]) {
      const [before, after] = await Promise.all([
        mysqlAdapter.passwords.get(tenant.id, user.user_id),
        sqliteAdapter.passwords.get(tenant.id, user.user_id),
      ]);
      if ((before?.password ?? null) !== (after?.password ?? null)) {
        passwordMismatches++;
      }
    }
    if (passwordMismatches > 0) {
      console.error(`  ✗ ${passwordMismatches} password hashes differ (${tenant.id})`);
    }
    results.push(passwordMismatches === 0);
  }

  // Add other entities...

  if (results.every((result) => result)) {
    console.log("✓ All verifications passed! Ready to switch over.");
  } else {
    console.error("✗ Verification failed. Do not switch over yet.");
    process.exit(1);
  }
}

main().catch(console.error);
```

Run verification regularly:

```bash
tsx scripts/verify-migration.ts
```

### Phase 5: Monitor Sync Health

Add a monitoring endpoint to track sync errors:

```typescript
// src/routes/admin.ts
import { Hono } from "hono";
import { getSyncErrorStats } from "./adapters";

const admin = new Hono();

admin.get("/migration-status", (c) => {
  const errors = getSyncErrorStats();
  const totalErrors = Object.values(errors).reduce(
    (sum, count) => sum + count,
    0,
  );

  return c.json({
    status: totalErrors === 0 ? "healthy" : "errors",
    totalErrors,
    errorsByEntity: errors,
  });
});

export default admin;
```

### Phase 6: Switchover

Once verification passes and sync errors are minimal, switch to SQLite as primary:

```typescript
// src/adapters.ts
export const dataAdapter = {
  ...sqliteAdapter,
  users: createPassthroughAdapter({
    primary: sqliteAdapter.users, // ← Changed to SQLite
    secondaries: [
      {
        adapter: mysqlAdapter.users, // ← Keep MySQL as backup
        blocking: false, // Non-blocking now
        onError: handleSyncError("users (mysql-backup)"),
      },
    ],
  }),

  // Update all other entities similarly...
};
```

Deploy this change and monitor for issues. All reads now come from SQLite, while writes still go to both databases.

### Phase 7: Cleanup

After running successfully for a reasonable period (e.g., 1 week):

1. **Remove MySQL secondaries**:

```typescript
// src/adapters.ts
export const dataAdapter = sqliteAdapter; // Use SQLite directly
```

2. **Decommission MySQL database** (after taking a final backup)

3. **Clean up old code and dependencies**:

```bash
pnpm remove @authhero/kysely-adapter kysely kysely-planetscale
```

## Migration Checklist

Use this checklist to track your migration progress:

- [ ] Install and configure new adapter
- [ ] Set up passthrough adapters for all entities
- [ ] Deploy dual-write configuration
- [ ] Monitor sync errors (should be zero)
- [ ] Run backfill script
- [ ] Verify backfill completed successfully
- [ ] Run verification script regularly
- [ ] Monitor application performance with dual-write
- [ ] Plan switchover window
- [ ] Switch primary to new database
- [ ] Monitor new database performance
- [ ] Keep old database as backup for 1-2 weeks
- [ ] Final verification before cleanup
- [ ] Remove old database
- [ ] Clean up old adapter dependencies

## Best Practices

### Use Blocking for Critical Data

```typescript
// Critical data: use blocking to ensure consistency
users: createPassthroughAdapter({
  primary: oldAdapter.users,
  secondaries: [{ adapter: newAdapter.users, blocking: true }],
}),

// Logs: can be non-blocking
logs: createPassthroughAdapter({
  primary: oldAdapter.logs,
  secondaries: [{ adapter: newAdapter.logs, blocking: false }],
}),
```

### Monitor Everything

```typescript
const metrics = {
  syncErrors: new Map(),
  syncLatency: new Map(),
};

function handleSyncError(entity: string) {
  return (error: Error, method: string, args: unknown[]) => {
    // Increment error counter
    const key = `${entity}.${method}`;
    metrics.syncErrors.set(key, (metrics.syncErrors.get(key) || 0) + 1);

    // Alert if error rate is high
    if (metrics.syncErrors.get(key)! > 10) {
      sendAlert(`High sync error rate for ${key}`);
    }
  };
}
```

### Gradual Migration

Don't migrate everything at once. Start with less critical entities:

1. **Week 1**: Logs and sessions (can tolerate issues)
2. **Week 2**: Applications and connections
3. **Week 3**: Users and tenants (most critical)
4. **Week 4**: Switchover

### Have a Rollback Plan

Keep the rollback path simple - just change the configuration back:

```typescript
// Rollback: swap primary back to old database
export const dataAdapter = {
  users: createPassthroughAdapter({
    primary: oldAdapter.users, // ← Change back
    secondaries: [{ adapter: newAdapter.users, blocking: false }],
  }),
};
```

## Troubleshooting

### High Sync Latency

If writes are taking too long:

```typescript
// Use non-blocking for less critical data
secondaries: [
  {
    adapter: newAdapter.users,
    blocking: false, // Don't wait for sync
  },
];
```

### Sync Failures

If you see sync errors:

1. Check the `onError` logs for details
2. Verify database connectivity
3. Check for schema mismatches
4. Ensure data types are compatible
5. Verify foreign key constraints exist

### Data Mismatches

If verification fails:

1. Check the verification script output
2. Run backfill again for affected entities
3. Investigate specific mismatched records
4. Check for ongoing sync errors

## Advanced: Cross-Region Migration

For cross-region migrations with different ORMs:

```typescript
import createKyselyAdapters from "@authhero/kysely-adapter";
import createDrizzleAdapters from "@authhero/drizzle";

// Region 1: MySQL on PlanetScale + Kysely
const region1Adapter = createKyselyAdapters(region1Db);

// Region 2: D1 or SQLite + Drizzle
const region2Adapter = createDrizzleAdapters(region2Db);

// Write to both regions
const dataAdapter = {
  ...region1Adapter,
  users: createPassthroughAdapter({
    primary: region1Adapter.users,
    secondaries: [
      {
        adapter: region2Adapter.users,
        blocking: false, // Non-blocking for cross-region
        onError: (error) => {
          // Queue for retry
          retryQueue.add({ entity: "users", error });
        },
      },
    ],
  }),
};
```

## Special Case: Migrating from External Auth Providers

The same passthrough adapter pattern can be used to migrate from external authentication services like Auth0, Okta, AWS Cognito, or other identity providers to AuthHero. This approach uses an **auth-provider adapter** that proxies to the external service.

### Auth-Provider Adapter Concept

An auth-provider adapter implements the AuthHero adapter interfaces but proxies calls to an external authentication service's API:

```typescript
// Conceptual example - NOT provided by AuthHero
import { createPassthroughAdapter } from "@authhero/adapter-interfaces";

// Custom adapter that proxies to external auth service
const externalAuthAdapter = createExternalAuthAdapter({
  domain: "your-tenant.auth-provider.com",
  managementToken: process.env.AUTH_PROVIDER_TOKEN,
  clientId: process.env.AUTH_PROVIDER_CLIENT_ID,
  clientSecret: process.env.AUTH_PROVIDER_CLIENT_SECRET,
});

// AuthHero database adapter
const authHeroAdapter = createAdapters(db); // from "@authhero/drizzle"

// Phase 1: External auth primary, AuthHero secondary (dual-write)
const dataAdapter = {
  users: createPassthroughAdapter({
    primary: externalAuthAdapter.users, // Read from external service
    secondaries: [
      {
        adapter: authHeroAdapter.users, // Write to AuthHero
        blocking: true,
      },
    ],
  }),

  sessions: createPassthroughAdapter({
    primary: externalAuthAdapter.sessions,
    secondaries: [
      {
        adapter: authHeroAdapter.sessions,
        blocking: false,
      },
    ],
  }),

  // ... other entities
};
```

### What Needs to be Implemented

To create an auth-provider adapter, you need to implement these key components:

#### 1. User Management Adapter

```typescript
export function createExternalUsersAdapter(config: ExternalAuthConfig) {
  return {
    async get(tenantId: string, userId: string) {
      // Call external auth provider's API
      const response = await fetch(
        `https://${config.domain}/api/users/${userId}`,
        {
          headers: { Authorization: `Bearer ${config.managementToken}` },
        },
      );

      // Transform external format to AuthHero format
      const externalUser = await response.json();
      return transformToAuthHeroUser(externalUser);
    },

    async list(tenantId: string, params) {
      // Query users from external service
      // May need to filter by tenant using metadata or tags
      const response = await fetch(
        `https://${config.domain}/api/users?tenant=${tenantId}`,
        {
          headers: { Authorization: `Bearer ${config.managementToken}` },
        },
      );

      const externalUsers = await response.json();
      return {
        users: externalUsers.map(transformToAuthHeroUser),
      };
    },

    // Write operations during migration
    async create(tenantId: string, user) {
      // Option 1: Proxy to external service
      // Option 2: Throw error (read-only during migration)
      throw new Error("User creation not supported during migration");
    },

    async update(tenantId: string, userId: string, updates) {
      // Proxy updates to external service
      const response = await fetch(
        `https://${config.domain}/api/users/${userId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${config.managementToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(transformToExternalFormat(updates)),
        },
      );

      return transformToAuthHeroUser(await response.json());
    },
  };
}
```

#### 2. Session/Token Management

```typescript
export function createExternalSessionsAdapter(config: ExternalAuthConfig) {
  return {
    async get(tenantId: string, sessionId: string) {
      // External auth services typically don't expose sessions
      // Store mapping of AuthHero session ID -> external tokens

      const mapping = await getSessionMapping(sessionId);
      if (!mapping) return null;

      // Validate external token is still valid
      const isValid = await validateExternalToken(
        mapping.external_access_token,
      );

      if (!isValid) {
        // Try to refresh using external refresh token
        const refreshed = await refreshExternalToken(
          mapping.external_refresh_token,
        );

        if (refreshed) {
          await updateSessionMapping(sessionId, refreshed);
          return transformToAuthHeroSession(refreshed);
        }

        return null;
      }

      return transformToAuthHeroSession(mapping);
    },

    async create(tenantId: string, session) {
      // When proxying authentication:
      // 1. External service handles actual auth
      // 2. Receive external tokens
      // 3. Store mapping for future use

      const sessionId = generateSessionId();

      await storeSessionMapping(sessionId, {
        tenant_id: tenantId,
        user_id: session.user_id,
        external_access_token: session.external_access_token,
        external_refresh_token: session.external_refresh_token,
        external_id_token: session.external_id_token,
        expires_at: session.expires_at,
      });

      return {
        id: sessionId,
        tenant_id: tenantId,
        user_id: session.user_id,
        created_at: new Date().toISOString(),
        expires_at: session.expires_at,
      };
    },
  };
}
```

#### 3. Authentication Flow Proxying

```typescript
// In your AuthHero initialization
export function createAuthFlowProxy(config: ExternalAuthConfig) {
  return {
    // Proxy OAuth authorization to external service
    async handleAuthorize(params) {
      // Redirect to external auth service
      return {
        redirect: `https://${config.domain}/authorize?${new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: params.redirect_uri,
          response_type: params.response_type,
          scope: params.scope,
          state: params.state,
        })}`,
      };
    },

    // Proxy token exchange to external service
    async handleTokenExchange(params) {
      const response = await fetch(`https://${config.domain}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: params.grant_type,
          code: params.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: params.redirect_uri,
        }),
      });

      const tokens = await response.json();

      // Store in AuthHero session format
      await authHeroAdapter.sessions.create(tenantId, {
        user_id: tokens.sub,
        external_access_token: tokens.access_token,
        external_refresh_token: tokens.refresh_token,
        expires_at: new Date(
          Date.now() + tokens.expires_in * 1000,
        ).toISOString(),
      });

      return tokens;
    },
  };
}
```

### Migration Process

The migration follows the same phases as database migration:

#### Phase 1: Dual-Write Mode

```typescript
// External auth is primary, AuthHero is secondary
const dataAdapter = {
  users: createPassthroughAdapter({
    primary: externalAuthAdapter.users,
    secondaries: [{ adapter: authHeroAdapter.users, blocking: true }],
  }),
};
```

All reads from external service, all writes go to both.

#### Phase 2: Backfill Historical Data

```typescript
// scripts/backfill-from-external-auth.ts
async function backfillUsers() {
  const { users } = await externalAuthAdapter.users.list("tenant-id", {});

  for (const user of users) {
    await authHeroAdapter.users.create("tenant-id", user);
  }
}

// Run backfill
await backfillUsers();
```

#### Phase 3: Session Continuity Strategy

Unlike database migration, session continuity is possible through token proxying:

```typescript
// During migration, sessions from external auth continue to work
// AuthHero proxies token validation/refresh to external service
// New authentications create both external and AuthHero sessions

// Progressive migration: new users -> AuthHero, existing -> external
async function routeAuthentication(userId: string) {
  const user = await authHeroAdapter.users.get("tenant-id", userId);

  if (user && user.migrated_to_authhero) {
    // Use AuthHero authentication
    return authHeroAuth(user);
  }

  // Proxy to external auth
  return externalAuth(userId);
}
```

#### Phase 4: Verification

```typescript
// Verify users match between systems
const externalUsers = await externalAuthAdapter.users.list("tenant-id", {});
const authHeroUsers = await authHeroAdapter.users.list("tenant-id", {});

console.log(`External: ${externalUsers.users.length}`);
console.log(`AuthHero: ${authHeroUsers.users.length}`);

// Check for discrepancies
const missing = externalUsers.users.filter(
  (eu) => !authHeroUsers.users.find((au) => au.user_id === eu.user_id),
);
console.log(`Missing in AuthHero: ${missing.length}`);
```

#### Phase 5: Switchover

```typescript
// Switch to AuthHero as primary
const dataAdapter = {
  users: createPassthroughAdapter({
    primary: authHeroAdapter.users, // Now primary
    secondaries: [
      {
        adapter: externalAuthAdapter.users, // Keep as backup
        blocking: false,
      },
    ],
  }),
};
```

#### Phase 6: Remove External Adapter

```typescript
// Once confident, use AuthHero directly
const dataAdapter = authHeroAdapter;
```

### Key Challenges

1. **Session Format Differences**: External auth tokens must be mapped to AuthHero sessions
2. **Tenant Mapping**: External services may not have native multi-tenancy support
3. **Feature Parity**: Not all features may map 1:1 (custom database scripts, rules, etc.)
4. **Rate Limits**: External API rate limits may slow down backfill
5. **Token Expiry**: Must handle token refresh during migration period

### Benefits of This Approach

- **Zero downtime**: External auth keeps working during migration
- **Session continuity**: Existing sessions remain valid through proxying
- **Gradual rollout**: Migrate users progressively
- **Reversible**: Can switch back to external auth if issues arise
- **Familiar pattern**: Same as database migration with passthrough adapters

### Example: Auth0-to-AuthHero Migration

```typescript
// Custom Auth0 adapter implementation
const auth0Adapter = createAuth0Adapter({
  domain: "your-tenant.auth0.com",
  managementToken: process.env.AUTH0_MGMT_TOKEN,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
});

const authHeroAdapter = createAdapters(db); // from "@authhero/drizzle"

// Week 1-2: Dual-write, Auth0 primary
const phase1Adapter = {
  users: createPassthroughAdapter({
    primary: auth0Adapter.users,
    secondaries: [{ adapter: authHeroAdapter.users, blocking: true }],
  }),
};

// Week 3: Backfill and verify
await backfillFromAuth0();
await verifyDataSync();

// Week 4: Switch to AuthHero primary, Auth0 backup
const phase2Adapter = {
  users: createPassthroughAdapter({
    primary: authHeroAdapter.users,
    secondaries: [{ adapter: auth0Adapter.users, blocking: false }],
  }),
};

// Week 5+: Remove Auth0 once stable
const finalAdapter = authHeroAdapter;
```

::: warning
**Note**: AuthHero does not currently provide adapters for external authentication services (Auth0, Okta, AWS Cognito, etc.). These would need to be implemented as custom adapters following the patterns described above.

If you're migrating from an external auth provider and need assistance designing an adapter, please open a discussion on [GitHub](https://github.com/authhero/authhero/discussions).
:::

## Related Documentation

- [Adapter Concepts](/architecture/adapters) - Understanding adapter architecture
- [Adapter Interfaces](/customization/adapter-interfaces/) - Complete adapter API reference
- [Kysely Adapter](/customization/kysely/) - SQLite and MySQL (PlanetScale) adapter
- [Drizzle Adapter](/customization/drizzle/) - Drizzle ORM adapter
- [AWS Adapter](/customization/aws-adapter/) - DynamoDB adapter
