import { Kysely } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("migration_sources")
    .addColumn("id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("tenant_id", "varchar(191)", (col) => col.notNull())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("provider", "varchar(32)", (col) => col.notNull())
    .addColumn("connection", "varchar(255)", (col) => col.notNull())
    .addColumn("enabled", "boolean", (col) => col.notNull())
    .addColumn("credentials", "text", (col) => col.notNull())
    .addColumn("created_at", "varchar(35)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(35)", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_migration_sources_tenant_id")
    .on("migration_sources")
    .columns(["tenant_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("migration_sources").execute();
}
