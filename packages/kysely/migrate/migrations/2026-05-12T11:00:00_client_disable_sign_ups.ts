// @ts-nocheck - Migration uses JSON helpers not in the Database type
import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Promote `disable_sign_ups` from the free-form `client_metadata` blob to a
 * typed column, and add a new `hide_sign_up_disabled_error` column.
 *
 * `hide_sign_up_disabled_error` is the enumeration-safe variant — when both
 * flags are on, the identifier screen no longer reveals that an email is
 * unknown.
 *
 * Backfill: copy any row where `client_metadata.disable_sign_ups = "true"`
 * into the new column, then drop the key from the JSON so there's a single
 * source of truth going forward.
 */

async function getDatabaseType(
  db: Kysely<Database>,
): Promise<"mysql" | "sqlite"> {
  try {
    await sql`SELECT VERSION()`.execute(db);
    return "mysql";
  } catch {
    return "sqlite";
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("clients")
    .addColumn("disable_sign_ups", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await db.schema
    .alterTable("clients")
    .addColumn("hide_sign_up_disabled_error", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  const dbType = await getDatabaseType(db);
  if (dbType === "mysql") {
    await sql`
      UPDATE clients
      SET disable_sign_ups = 1,
          client_metadata = JSON_REMOVE(client_metadata, '$.disable_sign_ups')
      WHERE JSON_UNQUOTE(JSON_EXTRACT(client_metadata, '$.disable_sign_ups')) = 'true'
    `.execute(db);

    await sql`
      UPDATE clients
      SET client_metadata = JSON_REMOVE(client_metadata, '$.disable_sign_ups')
      WHERE JSON_EXTRACT(client_metadata, '$.disable_sign_ups') IS NOT NULL
    `.execute(db);
  } else {
    await sql`
      UPDATE clients
      SET disable_sign_ups = 1,
          client_metadata = json_remove(client_metadata, '$.disable_sign_ups')
      WHERE json_extract(client_metadata, '$.disable_sign_ups') = 'true'
    `.execute(db);

    await sql`
      UPDATE clients
      SET client_metadata = json_remove(client_metadata, '$.disable_sign_ups')
      WHERE json_extract(client_metadata, '$.disable_sign_ups') IS NOT NULL
    `.execute(db);
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("clients")
    .dropColumn("hide_sign_up_disabled_error")
    .execute();
  await db.schema
    .alterTable("clients")
    .dropColumn("disable_sign_ups")
    .execute();
}
