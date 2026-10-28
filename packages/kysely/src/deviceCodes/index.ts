import { Kysely } from "kysely";
import {
  deviceCodeSchema,
  type DeviceCodesAdapter,
} from "@authhero/adapter-interfaces";
import type { Database } from "../db";

export function createDeviceCodesAdapter(
  db: Kysely<Database>,
): DeviceCodesAdapter {
  const parse = (row: unknown) =>
    row
      ? deviceCodeSchema.parse(
          Object.fromEntries(
            Object.entries(row).filter(([, value]) => value !== null),
          ),
        )
      : null;
  return {
    async create(tenant_id, code) {
      await db
        .insertInto("device_codes")
        .values({ ...code, tenant_id })
        .execute();
    },
    async get(tenantId, hash) {
      return parse(
        await db
          .selectFrom("device_codes")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("device_code_hash", "=", hash)
          .executeTakeFirst(),
      );
    },
    async getByUserCode(tenantId, hash) {
      return parse(
        await db
          .selectFrom("device_codes")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("user_code_hash", "=", hash)
          .executeTakeFirst(),
      );
    },
    async update(tenantId, hash, version, patch) {
      const result = await db
        .updateTable("device_codes")
        .set({ ...patch, version: version + 1 })
        .where("tenant_id", "=", tenantId)
        .where("device_code_hash", "=", hash)
        .where("version", "=", version)
        .executeTakeFirst();
      return result.numUpdatedRows > 0;
    },
    async incrementAttempts(tenant_id, key, expires_at) {
      // Portable to SQLite, MySQL and Postgres without dialect-specific UPSERT.
      try {
        await db
          .insertInto("device_flow_limits")
          .values({ tenant_id, key, expires_at, attempts: 0 })
          .execute();
      } catch (error) {
        const existing = await db
          .selectFrom("device_flow_limits")
          .select("key")
          .where("tenant_id", "=", tenant_id)
          .where("key", "=", key)
          .executeTakeFirst();
        if (!existing) throw error;
      }
      // CAS returns this request's count even if another increment interleaves.
      for (;;) {
        const row = await db
          .selectFrom("device_flow_limits")
          .select("attempts")
          .where("tenant_id", "=", tenant_id)
          .where("key", "=", key)
          .executeTakeFirstOrThrow();
        const result = await db
          .updateTable("device_flow_limits")
          .set({ attempts: row.attempts + 1 })
          .where("tenant_id", "=", tenant_id)
          .where("key", "=", key)
          .where("attempts", "=", row.attempts)
          .executeTakeFirst();
        if (result.numUpdatedRows > 0) return row.attempts + 1;
      }
    },
    async cleanup(olderThan) {
      let total = 0;
      for (const table of ["device_codes", "device_flow_limits"] as const) {
        const result = await db
          .deleteFrom(table)
          .where("expires_at", "<", olderThan)
          .executeTakeFirst();
        total += Number(result.numDeletedRows);
      }
      return total;
    },
  };
}
