import { Kysely, sql } from "kysely";
import type { Database } from "../../src/db";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("tenant_member_requests")
    .addColumn("tenant_id", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("id", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("kind", sql`varchar(32)`, (c) => c.notNull())
    .addColumn("status", sql`varchar(16)`, (c) => c.notNull())
    .addColumn("requested_by", sql`varchar(255)`, (c) => c.notNull())
    .addColumn("payload", sql`text`, (c) => c.notNull())
    .addColumn("result", sql`text`)
    .addColumn("error", sql`text`)
    .addColumn("notified_at", sql`varchar(35)`)
    .addColumn("created_at", sql`varchar(35)`, (c) => c.notNull())
    .addColumn("updated_at", sql`varchar(35)`, (c) => c.notNull())
    .addColumn("finished_at", sql`varchar(35)`)
    .addPrimaryKeyConstraint("tenant_member_requests_pk", ["tenant_id", "id"])
    .execute();
  await db.schema
    .createIndex("tenant_member_requests_status_idx")
    .on("tenant_member_requests")
    .columns(["tenant_id", "status", "created_at"])
    .execute();
  await db.schema
    .createIndex("tenant_member_requests_finished_idx")
    .on("tenant_member_requests")
    .column("finished_at")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("tenant_member_requests").execute();
}
