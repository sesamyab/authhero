import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Add `session_transfer` to sessions and refresh_tokens: JSON `{ client_id,
 * family_id, cascade_revocation }` recording that the session was created by
 * redeeming a session_transfer_token (#1710), and which refresh token family
 * that token was minted from. Nullable; existing rows read back as "not
 * transferred".
 *
 * It lives on refresh_tokens as well because a refresh token outlives its
 * session row, and cascade revocation has to keep working after cleanup has
 * removed the session.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(
  db: Kysely<Database>,
  tableName: string,
  columnName: string,
): Promise<void> {
  try {
    await db.schema
      .alterTable(tableName)
      .addColumn(columnName, sql`text`)
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

export async function up(db: Kysely<Database>): Promise<void> {
  await safeAddColumn(db, "sessions", "session_transfer");
  await safeAddColumn(db, "refresh_tokens", "session_transfer");
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

export async function down(db: Kysely<Database>): Promise<void> {
  await safeDropColumn(db, "refresh_tokens", "session_transfer");
  await safeDropColumn(db, "sessions", "session_transfer");
}
