import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Junction table linking organizations to tenant-level connections, mirroring
 * Auth0's `/api/v2/organizations/{id}/enabled_connections`. Uniqueness is on
 * (tenant_id, organization_id, connection_id) — a connection can be enabled
 * once per org, with per-org policy flags.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("organization_connections")
    .addColumn("tenant_id", "varchar(191)", (col) => col.notNull())
    .addColumn("organization_id", "varchar(21)", (col) => col.notNull())
    .addColumn("connection_id", "varchar(191)", (col) => col.notNull())
    .addColumn("assign_membership_on_login", "boolean", (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn("show_as_button", "boolean", (col) => col.notNull().defaultTo(1))
    .addColumn("is_signup_enabled", "boolean", (col) =>
      col.notNull().defaultTo(1),
    )
    .addColumn("created_at", "varchar(35)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(35)", (col) => col.notNull())
    .addUniqueConstraint("organization_connections_unique", [
      "tenant_id",
      "organization_id",
      "connection_id",
    ])
    .addForeignKeyConstraint(
      "organization_connections_organization_fk",
      ["organization_id"],
      "organizations",
      ["id"],
      (cb) => cb.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "organization_connections_connection_fk",
      ["tenant_id", "connection_id"],
      "connections",
      ["tenant_id", "id"],
      (cb) => cb.onDelete("cascade"),
    )
    .execute();

  await db.schema
    .createIndex("idx_organization_connections_tenant_org")
    .on("organization_connections")
    .columns(["tenant_id", "organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_organization_connections_tenant_connection")
    .on("organization_connections")
    .columns(["tenant_id", "connection_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("organization_connections").execute();
}
