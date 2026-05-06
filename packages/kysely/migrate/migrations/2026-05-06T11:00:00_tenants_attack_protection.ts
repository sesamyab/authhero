import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Adds a nullable JSON column on `tenants` that stores Auth0's
 * /api/v2/attack-protection sub-resources (breached_password_detection,
 * brute_force_protection, suspicious_ip_throttling). Singleton per tenant —
 * no separate table.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("tenants")
    .addColumn("attack_protection", "text")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable("tenants")
    .dropColumn("attack_protection")
    .execute();
}
