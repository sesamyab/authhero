import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("email_templates")
    .addColumn("tenant_id", "varchar(255)", (col) => col.notNull())
    .addColumn("template", "varchar(64)", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("from", "varchar(255)", (col) => col.notNull())
    .addColumn("subject", "varchar(255)", (col) => col.notNull())
    .addColumn("syntax", "varchar(16)", (col) =>
      col.notNull().defaultTo("liquid"),
    )
    .addColumn("result_url", "varchar(2048)")
    .addColumn("url_lifetime_in_seconds", "integer")
    .addColumn("include_email_in_redirect", "integer", (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`include_email_in_redirect IN (0, 1)`),
    )
    .addColumn("enabled", "integer", (col) =>
      col.notNull().defaultTo(1).check(sql`enabled IN (0, 1)`),
    )
    .addColumn("created_at", "varchar(35)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(35)", (col) => col.notNull())
    .addPrimaryKeyConstraint("email_templates_pk", ["tenant_id", "template"])
    .addForeignKeyConstraint(
      "email_templates_tenant_fk",
      ["tenant_id"],
      "tenants",
      ["id"],
      (cb) => cb.onDelete("cascade"),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("email_templates").execute();
}
