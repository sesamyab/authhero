import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Kind-specific settings and a pause reason for fleet rollouts
 * (docs/design/tenant-config-inheritance.md, section 4.2). Both nullable; the
 * existing rollout kinds do not use them.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(
  db: Kysely<Database>,
  columnName: string,
  type: ReturnType<typeof sql>,
): Promise<void> {
  try {
    await db.schema
      .alterTable("rollouts")
      .addColumn(columnName, type)
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
async function safeDropColumn(
  db: Kysely<Database>,
  columnName: string,
): Promise<void> {
  try {
    await db.schema.alterTable("rollouts").dropColumn(columnName).execute();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await safeAddColumn(db, "config", sql`text`);
  await safeAddColumn(db, "paused_reason", sql`text`);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await safeDropColumn(db, "paused_reason");
  await safeDropColumn(db, "config");
}
