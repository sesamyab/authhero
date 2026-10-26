import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Per-tenant config sync mode (docs/design/tenant-config-inheritance.md,
 * section 5 step 3): `inherit-on-read` or `synced`. Nullable; unset reads as
 * `inherit-on-read`, which is today's behaviour.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(db: Kysely<Database>): Promise<void> {
  try {
    await db.schema
      .alterTable("tenants")
      .addColumn("config_sync", sql`varchar(16)`)
      .execute();
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
async function safeDropColumn(db: Kysely<Database>): Promise<void> {
  try {
    await db.schema.alterTable("tenants").dropColumn("config_sync").execute();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await safeAddColumn(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await safeDropColumn(db);
}
