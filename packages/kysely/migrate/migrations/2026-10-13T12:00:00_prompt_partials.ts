import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("prompt_partials")
    .ifNotExists()
    .addColumn("tenant_id", sql`varchar(191)`, (col) => col.notNull())
    .addColumn("prompt", sql`varchar(64)`, (col) => col.notNull())
    .addColumn("body", sql`text`, (col) => col.notNull())
    .addColumn("created_at_ts", sql`bigint`, (col) => col.notNull())
    .addColumn("updated_at_ts", sql`bigint`, (col) => col.notNull())
    .addPrimaryKeyConstraint("prompt_partials_pk", ["tenant_id", "prompt"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("prompt_partials").ifExists().execute();
}
