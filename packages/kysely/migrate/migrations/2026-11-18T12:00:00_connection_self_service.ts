import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Add `self_service` to connections: JSON `{ profile_id, domains: [{ domain,
 * status, verified_at }] }` marking a connection set up through Self-Service
 * SSO (#1763) and the email domains verified for it. Nullable; existing rows
 * read back as "not a self-service connection". Internal state, never part of
 * the Management API's connection object.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  try {
    await db.schema
      .alterTable("connections")
      .addColumn("self_service", sql`text`)
      .execute();
  } catch (error: unknown) {
    // Tolerate "duplicate column" (MySQL errno 1060) so a re-run is safe.
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

export async function down(db: Kysely<Database>): Promise<void> {
  try {
    await db.schema
      .alterTable("connections")
      .dropColumn("self_service")
      .execute();
  } catch (error: unknown) {
    // PlanetScale doesn't support IF EXISTS here, so tolerate "doesn't exist".
    if (error instanceof Error && error.message.includes("1091")) return;
    throw error;
  }
}
