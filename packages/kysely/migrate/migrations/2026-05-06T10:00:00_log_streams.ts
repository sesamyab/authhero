import { Kysely } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("log_streams")
    .addColumn("id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("tenant_id", "varchar(191)", (col) => col.notNull())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("type", "varchar(64)", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("sink", "text", (col) => col.notNull())
    .addColumn("filters", "text")
    .addColumn("is_priority", "boolean")
    .addColumn("created_at", "varchar(35)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(35)", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_log_streams_tenant_id")
    .on("log_streams")
    .columns(["tenant_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("log_streams").execute();
}
