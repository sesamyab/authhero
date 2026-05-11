import { Kysely } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("branding")
    .addColumn("dark_mode", "varchar(8)")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable("branding").dropColumn("dark_mode").execute();
}
