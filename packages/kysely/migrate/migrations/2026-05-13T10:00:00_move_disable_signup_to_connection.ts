// @ts-nocheck - Migration uses untyped JSON columns
import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Move the signup-block setting from the client to the connection.
 *
 * The previous shape — `clients.disable_sign_ups` — gated all connections
 * via a single client flag, which forced federated/HRD logins through the
 * same block as password signup. The new shape stores the flag inside
 * `connections.options.disable_signup` so each connection can be configured
 * independently, and the screens/preUserSignupHook resolve it per-connection.
 *
 * Backfill: for every client with `disable_sign_ups = 1`, set
 * `disable_signup = true` on every connection whose id appears in the
 * client's `connections` JSON array. If multiple clients share a connection
 * and only some had signups disabled, the connection now blocks signup for
 * all of them — this is the natural consequence of moving from client-scope
 * to connection-scope and is called out in the changeset.
 */

async function getDatabaseType(
  db: Kysely<Database>,
): Promise<"mysql" | "sqlite"> {
  try {
    await sql`SELECT VERSION()`.execute(db);
    return "mysql";
  } catch {
    return "sqlite";
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  const dbType = await getDatabaseType(db);

  // Collect (tenant_id, connection_id) pairs that need disable_signup=true.
  const clientsToMigrate = await db
    .selectFrom("clients")
    .select(["tenant_id", "connections"])
    .where("disable_sign_ups", "=", 1)
    .execute();

  const targets = new Map<string, Set<string>>();
  for (const row of clientsToMigrate) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.connections || "[]");
    } catch {
      ids = [];
    }
    if (!Array.isArray(ids) || ids.length === 0) continue;
    let set = targets.get(row.tenant_id);
    if (!set) {
      set = new Set();
      targets.set(row.tenant_id, set);
    }
    for (const id of ids) set.add(id);
  }

  for (const [tenant_id, ids] of targets) {
    const connections = await db
      .selectFrom("connections")
      .select(["id", "options"])
      .where("tenant_id", "=", tenant_id)
      .where("id", "in", [...ids])
      .execute();

    for (const conn of connections) {
      let options: Record<string, unknown> = {};
      try {
        options = conn.options ? JSON.parse(conn.options) : {};
      } catch {
        options = {};
      }
      if (options.disable_signup === true) continue;
      options.disable_signup = true;
      await db
        .updateTable("connections")
        .set({ options: JSON.stringify(options) })
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", conn.id)
        .execute();
    }
  }

  await db.schema
    .alterTable("clients")
    .dropColumn("disable_sign_ups")
    .execute();

  // Suppress unused-variable warning for the database-type check; some SQL
  // flavors may need branching in future revisions.
  void dbType;
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("clients")
    .addColumn("disable_sign_ups", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
}
