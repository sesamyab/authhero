import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Adds the columns needed for Auth0-style refresh-token rotation and at-rest
 * hashing. All columns are nullable so legacy (pre-rotation) rows continue to
 * resolve via the `id`-only lookup path during the back-compat window.
 *
 *   - `token_lookup`: plaintext lookup slice extracted from the wire token
 *     (`rt_<lookup>.<secret>`); indexed for the refresh-grant path.
 *   - `token_hash`: SHA-256 hex of the secret part of the wire token.
 *   - `family_id`: root token id of a rotation chain. Used to revoke an
 *     entire family on reuse detection or admin revocation.
 *   - `rotated_to`: most recently issued child id (debug/traceability).
 *   - `rotated_at_ts`: time of the *first* rotation; anchors the leeway
 *     window so siblings minted within it don't extend exposure.
 *
 * Each addColumn / dropColumn is its own ALTER TABLE statement because
 * SQLite (and some MySQL configurations) don't accept multiple ADD COLUMN
 * clauses in a single ALTER TABLE.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("refresh_tokens")
    .addColumn("token_lookup", "varchar(16)")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .addColumn("token_hash", "varchar(64)")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .addColumn("family_id", "varchar(26)")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .addColumn("rotated_to", "varchar(26)")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .addColumn("rotated_at_ts", "bigint")
    .execute();

  await db.schema
    .createIndex("idx_refresh_tokens_token_lookup")
    .on("refresh_tokens")
    .columns(["tenant_id", "token_lookup"])
    .execute();

  await db.schema
    .createIndex("idx_refresh_tokens_family_id")
    .on("refresh_tokens")
    .columns(["tenant_id", "family_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .dropIndex("idx_refresh_tokens_family_id")
    .on("refresh_tokens")
    .execute();

  await db.schema
    .dropIndex("idx_refresh_tokens_token_lookup")
    .on("refresh_tokens")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .dropColumn("rotated_at_ts")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .dropColumn("rotated_to")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .dropColumn("family_id")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .dropColumn("token_hash")
    .execute();

  await db.schema
    .alterTable("refresh_tokens")
    .dropColumn("token_lookup")
    .execute();
}
