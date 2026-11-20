import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Self-Service SSO storage (issue #1763): profiles (custom text is a JSON
 * column of the profile) and SSO access tickets. `sso_access_tickets` stores
 * only a hash of the ticket id (the bearer value in the ticket URL); the hash
 * is unique. A self-service connection's email domains live on the
 * connection (`connections.self_service`).
 */

// MySQL has no `CREATE INDEX IF NOT EXISTS`, so tolerate "duplicate key name"
// (errno 1061) / SQLite's "already exists" instead of asking for it. mysql2
// reports errno 1061 in `errno` with a "Duplicate key name '...'" message.
function isDuplicateIndexError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("errno" in error && error.errno === 1061) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("1061") ||
    message.includes("duplicate key name") ||
    message.includes("already exists")
  );
}

async function safeCreateIndex(
  db: Kysely<Database>,
  indexName: string,
  tableName: string,
  columns: string[],
  unique: boolean,
): Promise<void> {
  try {
    let builder = db.schema
      .createIndex(indexName)
      .on(tableName)
      .columns(columns);
    if (unique) builder = builder.unique();
    await builder.execute();
  } catch (error: unknown) {
    if (isDuplicateIndexError(error)) return;
    throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("self_service_profiles")
    .ifNotExists()
    .addColumn("id", sql`varchar(64)`, (col) => col.notNull())
    .addColumn("tenant_id", sql`varchar(255)`, (col) => col.notNull())
    .addColumn("name", sql`varchar(255)`, (col) => col.notNull())
    // text: the adapter stores descriptions as given, whatever their length.
    .addColumn("description", sql`text`)
    .addColumn("allowed_strategies", sql`text`)
    .addColumn("user_attributes", sql`text`)
    .addColumn("branding", sql`text`)
    // JSON: language -> page -> custom text.
    .addColumn("custom_text", sql`text`)
    .addColumn("created_at", sql`varchar(35)`, (col) => col.notNull())
    .addColumn("updated_at", sql`varchar(35)`, (col) => col.notNull())
    .addPrimaryKeyConstraint("self_service_profiles_pk", ["id"])
    .execute();
  await safeCreateIndex(
    db,
    "self_service_profiles_tenant_id_idx",
    "self_service_profiles",
    ["tenant_id"],
    false,
  );

  await db.schema
    .createTable("sso_access_tickets")
    .ifNotExists()
    .addColumn("id", sql`varchar(64)`, (col) => col.notNull())
    .addColumn("tenant_id", sql`varchar(255)`, (col) => col.notNull())
    .addColumn("profile_id", sql`varchar(64)`, (col) => col.notNull())
    .addColumn("ticket_hash", sql`varchar(128)`, (col) => col.notNull())
    .addColumn("connection_id", sql`varchar(255)`)
    .addColumn("connection_config", sql`text`)
    .addColumn("enabled_clients", sql`text`)
    .addColumn("enabled_organizations", sql`text`)
    .addColumn("domain_verification", sql`varchar(16)`, (col) => col.notNull())
    .addColumn("expires_at", sql`varchar(35)`, (col) => col.notNull())
    .addColumn("revoked_at", sql`varchar(35)`)
    .addColumn("completed_at", sql`varchar(35)`)
    .addColumn("created_at", sql`varchar(35)`, (col) => col.notNull())
    .addColumn("updated_at", sql`varchar(35)`, (col) => col.notNull())
    .addPrimaryKeyConstraint("sso_access_tickets_pk", ["id"])
    .execute();
  await safeCreateIndex(
    db,
    "sso_access_tickets_ticket_hash_idx",
    "sso_access_tickets",
    ["ticket_hash"],
    true,
  );
  await safeCreateIndex(
    db,
    "sso_access_tickets_tenant_profile_idx",
    "sso_access_tickets",
    ["tenant_id", "profile_id"],
    false,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("sso_access_tickets").ifExists().execute();
  await db.schema.dropTable("self_service_profiles").ifExists().execute();
}
