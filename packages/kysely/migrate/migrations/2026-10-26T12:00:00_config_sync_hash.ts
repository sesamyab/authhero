import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * State for tenant config sync (docs/design/tenant-config-inheritance.md,
 * section 4.1): the content hash of the resolved config last applied to a
 * tenant and when. Nullable; unset means the tenant has never been synced.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(
  db: Kysely<Database>,
  columnName: string,
  type: ReturnType<typeof sql>,
): Promise<void> {
  try {
    await db.schema.alterTable("tenants").addColumn(columnName, type).execute();
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
  columnName: string,
): Promise<void> {
  try {
    await db.schema.alterTable("tenants").dropColumn(columnName).execute();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await safeAddColumn(db, "config_sync_hash", sql`varchar(64)`);
  await safeAddColumn(db, "config_synced_at", sql`varchar(35)`);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await safeDropColumn(db, "config_synced_at");
  await safeDropColumn(db, "config_sync_hash");
}
