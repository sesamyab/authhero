import { Kysely, sql } from "kysely";
import type { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("device_codes")
    .addColumn("tenant_id", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("device_code_hash", sql`varchar(64)`, (c) => c.notNull())
    .addColumn("user_code_hash", sql`varchar(64)`, (c) => c.notNull())
    .addColumn("client_id", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("scope", sql`text`)
    .addColumn("audience", sql`text`)
    .addColumn("status", sql`varchar(16)`, (c) => c.notNull())
    .addColumn("login_id", sql`varchar(255)`)
    .addColumn("expires_at", sql`varchar(35)`, (c) => c.notNull())
    .addColumn("created_at", sql`varchar(35)`, (c) => c.notNull())
    .addColumn("last_polled_at", sql`varchar(35)`)
    .addColumn("interval", "integer", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("device_codes_pk", [
      "tenant_id",
      "device_code_hash",
    ])
    .addUniqueConstraint("device_codes_user_code_idx", [
      "tenant_id",
      "user_code_hash",
    ])
    .execute();
  await db.schema
    .createIndex("device_codes_expiry_idx")
    .on("device_codes")
    .column("expires_at")
    .execute();
  await db.schema
    .createTable("device_flow_limits")
    .addColumn("tenant_id", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("key", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("attempts", "integer", (c) => c.notNull())
    .addColumn("expires_at", sql`varchar(35)`, (c) => c.notNull())
    .addPrimaryKeyConstraint("device_flow_limits_pk", ["tenant_id", "key"])
    .execute();
  await db.schema
    .createIndex("device_flow_limits_expiry_idx")
    .on("device_flow_limits")
    .column("expires_at")
    .execute();
}
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("device_flow_limits").execute();
  await db.schema.dropTable("device_codes").execute();
}
