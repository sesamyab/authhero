import { Tenant } from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";
import { tenantToSqlTenant } from "./utils";

// Cleared with an explicit null, which the mapping would otherwise drop: a
// detached tenant has no parent and no sync state.
const CLEARABLE_FIELDS = [
  "parent_tenant_id",
  "config_sync_hash",
  "config_synced_at",
] as const;

export function update(db: Kysely<Database>) {
  return async (id: string, tenant: Partial<Tenant>): Promise<void> => {
    const sqlTenant = tenantToSqlTenant(tenant);

    const tenantWithModified = {
      ...sqlTenant,
      ...Object.fromEntries(
        CLEARABLE_FIELDS.filter((field) => tenant[field] === null).map(
          (field) => [field, null],
        ),
      ),
      id,
      updated_at: new Date().toISOString(),
    };

    await db
      .updateTable("tenants")
      .set(tenantWithModified)
      .where("id", "=", id)
      .execute();
  };
}
