import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Adds a nullable `default_client_id` on `tenants`. Used as the anchor client
 * for tenant-level flows that aren't tied to a specific application — most
 * notably `/connect/start` DCR consent. Roughly analogous to Auth0's Default
 * App / Global Client. No FK: callers tolerate a stale id by falling back to
 * the first available client, which keeps a brand-new tenant with zero
 * clients able to bootstrap its first integration via DCR.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("tenants")
    .addColumn("default_client_id", "varchar(255)")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("tenants")
    .dropColumn("default_client_id")
    .execute();
}
