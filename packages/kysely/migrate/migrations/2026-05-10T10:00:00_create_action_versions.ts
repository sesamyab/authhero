import { Kysely } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("action_versions")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("tenant_id", "varchar(191)", (col) => col.notNull())
    .addColumn("action_id", "varchar(255)", (col) => col.notNull())
    .addColumn("number", "integer", (col) => col.notNull())
    .addColumn("code", "text", (col) => col.notNull())
    .addColumn("runtime", "varchar(50)")
    .addColumn("secrets", "text")
    .addColumn("dependencies", "text")
    .addColumn("supported_triggers", "text")
    .addColumn("deployed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at_ts", "bigint", (col) => col.notNull())
    .addColumn("updated_at_ts", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_action_versions_action")
    .on("action_versions")
    .columns(["tenant_id", "action_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("action_versions").execute();
}
