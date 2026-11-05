import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Last accepted TOTP time step per authentication method (issue #1666), so a
 * TOTP code cannot be replayed within its validity window (RFC 6238 §5.2).
 * Nullable; unset means no code has been accepted since the column was added.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(db: Kysely<Database>): Promise<void> {
  try {
    await db.schema
      .alterTable("authentication_methods")
      .addColumn("totp_last_step", "integer")
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
    await db.schema
      .alterTable("authentication_methods")
      .dropColumn("totp_last_step")
      .execute();
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
