import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Tenant-wide default terms and privacy URLs for the universal login page
 * (#1735). Both nullable: existing rows read back without them and render
 * exactly as before. Auth0 has no equivalent, so these are AuthHero-only.
 */
const COLUMNS = ["terms_url", "privacy_url"] as const;

function isDuplicateColumn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("1060") ||
      error.message.toLowerCase().includes("duplicate column"))
  );
}

function isMissingColumn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("errno" in error && error.errno === 1091) ||
      ("code" in error && error.code === "ER_CANT_DROP_FIELD_OR_KEY") ||
      error.message.includes("1091") ||
      error.message.toLowerCase().includes("no such column"))
  );
}

export async function up(db: Kysely<Database>): Promise<void> {
  for (const column of COLUMNS) {
    try {
      await db.schema
        .alterTable("branding")
        .addColumn(column, sql`varchar(512)`)
        .execute();
    } catch (error: unknown) {
      // Tolerate "duplicate column" so a re-run is safe.
      if (!isDuplicateColumn(error)) throw error;
    }
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  for (const column of [...COLUMNS].reverse()) {
    try {
      await db.schema.alterTable("branding").dropColumn(column).execute();
    } catch (error: unknown) {
      if (!isMissingColumn(error)) throw error;
    }
  }
}
