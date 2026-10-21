import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Schema for tenant config inheritance (docs/design/tenant-config-inheritance.md,
 * sections 3.1 and 3.2). Nothing reads these columns yet.
 *
 * Every column is nullable and unset reads as today's behaviour:
 * `scope = local`, `override = none`, `enforce = false`, no parent tenant.
 * Rows that are already published through `is_system` (connections, actions,
 * resource servers) or `metadata.inheritable` (hooks) are backfilled to
 * `scope = shared`, `override = none`. `is_system` and `metadata.inheritable`
 * stay in place and remain the source of truth until read-time inheritance is
 * replaced.
 */

const PUBLISHING_TABLES = [
  "connections",
  "actions",
  "hooks",
  "resource_servers",
  "branding",
  "prompt_settings",
  "email_providers",
] as const;

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(
  db: Kysely<Database>,
  tableName: string,
  columnName: string,
  type: ReturnType<typeof sql>,
): Promise<void> {
  try {
    await db.schema.alterTable(tableName).addColumn(columnName, type).execute();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes("1060") ||
        error.message.toLowerCase().includes("duplicate column"))
    ) {
      return;
    }
    throw error;
  }
}

// PlanetScale doesn't support IF EXISTS here, so tolerate "doesn't exist".
async function safeDropColumn(
  db: Kysely<Database>,
  tableName: string,
  columnName: string,
): Promise<void> {
  try {
    await db.schema.alterTable(tableName).dropColumn(columnName).execute();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await safeAddColumn(db, "tenants", "parent_tenant_id", sql`varchar(191)`);

  for (const table of PUBLISHING_TABLES) {
    await safeAddColumn(db, table, "scope", sql`varchar(16)`);
    await safeAddColumn(db, table, "override", sql`varchar(16)`);
    await safeAddColumn(db, table, "enforce", sql`tinyint(1)`);
  }

  // Map the existing publishing flags onto the new fields. Set-based and
  // portable across MySQL and SQLite.
  for (const table of ["connections", "actions", "resource_servers"] as const) {
    await sql`UPDATE ${sql.table(table)} SET scope = 'shared', override = 'none' WHERE is_system = 1 AND scope IS NULL`.execute(
      db,
    );
  }
  // Hook metadata is a JSON-encoded text column written with JSON.stringify,
  // so a flagged hook always contains the compact `"inheritable":true`.
  await sql`UPDATE hooks SET scope = 'shared', override = 'none' WHERE scope IS NULL AND metadata LIKE '%"inheritable":true%'`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  for (const table of PUBLISHING_TABLES) {
    await safeDropColumn(db, table, "enforce");
    await safeDropColumn(db, table, "override");
    await safeDropColumn(db, table, "scope");
  }
  await safeDropColumn(db, "tenants", "parent_tenant_id");
}
