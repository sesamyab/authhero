import { Kysely } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("action_executions")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("tenant_id", "varchar(191)", (col) => col.notNull())
    .addColumn("trigger_id", "varchar(64)", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("results", "text", (col) => col.notNull())
    .addColumn("logs", "text")
    .addColumn("created_at_ts", "bigint", (col) => col.notNull())
    .addColumn("updated_at_ts", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_action_executions_tenant")
    .on("action_executions")
    .columns(["tenant_id", "id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("action_executions").execute();
}
