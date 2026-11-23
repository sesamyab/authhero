import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Developer app invites (#1776): `name` (operator-facing label), `created_by`
 * (Management API caller) and `source` (`invite`, `edit_link`,
 * `registration`, `connect`) on client_registration_tokens, plus an index for
 * listing a tenant's tokens newest first. All nullable; existing rows read
 * back without a label or source.
 */

// Tolerates "duplicate column" (MySQL errno 1060) so the migration is safe to
// re-run against a database that already has the column.
async function safeAddColumn(
  db: Kysely<Database>,
  columnName: string,
  length: number,
): Promise<void> {
  try {
    await db.schema
      .alterTable("client_registration_tokens")
      .addColumn(columnName, sql.raw(`varchar(${length})`))
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
  await safeAddColumn(db, "name", 255);
  await safeAddColumn(db, "created_by", 255);
  await safeAddColumn(db, "source", 16);
  try {
    await db.schema
      .createIndex("idx_client_registration_tokens_created")
      .on("client_registration_tokens")
      .columns(["tenant_id", "created_at_ts"])
      .execute();
  } catch (error: unknown) {
    // MySQL 1061 / SQLite "already exists": safe to re-run.
    if (
      error instanceof Error &&
      (error.message.includes("1061") ||
        error.message.toLowerCase().includes("already exists"))
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
    await db.schema
      .alterTable("client_registration_tokens")
      .dropColumn(columnName)
      .execute();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  // MySQL needs `DROP INDEX … ON table`; SQLite rejects the `ON`. The index
  // does not cover the dropped columns, so a leftover index is harmless.
  try {
    await db.schema
      .dropIndex("idx_client_registration_tokens_created")
      .on("client_registration_tokens")
      .execute();
  } catch {
    try {
      await db.schema
        .dropIndex("idx_client_registration_tokens_created")
        .execute();
    } catch {
      /* index may not exist */
    }
  }
  await safeDropColumn(db, "source");
  await safeDropColumn(db, "created_by");
  await safeDropColumn(db, "name");
}
