import { and, eq, sql } from "drizzle-orm";
import {
  deviceCodeSchema,
  type DeviceCodesAdapter,
} from "@authhero/adapter-interfaces";
import { deviceCodes, deviceFlowLimits } from "../schema/sqlite/deviceCodes";
import { removeNullProperties } from "../helpers/transform";
import type { DrizzleDb } from "./types";

export function createDeviceCodesAdapter(db: DrizzleDb): DeviceCodesAdapter {
  const parse = (row: typeof deviceCodes.$inferSelect | undefined) =>
    row ? deviceCodeSchema.parse(removeNullProperties(row)) : null;
  return {
    async create(tenant_id, code) {
      await db.insert(deviceCodes).values({ ...code, tenant_id });
    },
    async get(tenantId, hash) {
      return parse(
        await db
          .select()
          .from(deviceCodes)
          .where(
            and(
              eq(deviceCodes.tenant_id, tenantId),
              eq(deviceCodes.device_code_hash, hash),
            ),
          )
          .get(),
      );
    },
    async getByUserCode(tenantId, hash) {
      return parse(
        await db
          .select()
          .from(deviceCodes)
          .where(
            and(
              eq(deviceCodes.tenant_id, tenantId),
              eq(deviceCodes.user_code_hash, hash),
            ),
          )
          .get(),
      );
    },
    async update(tenantId, hash, version, patch) {
      const rows = await db
        .update(deviceCodes)
        .set({ ...patch, version: version + 1 })
        .where(
          and(
            eq(deviceCodes.tenant_id, tenantId),
            eq(deviceCodes.device_code_hash, hash),
            eq(deviceCodes.version, version),
          ),
        )
        .returning({ version: deviceCodes.version });
      return rows.length === 1;
    },
    async incrementAttempts(tenant_id, key, expires_at) {
      const [row] = await db
        .insert(deviceFlowLimits)
        .values({ tenant_id, key, attempts: 1, expires_at })
        .onConflictDoUpdate({
          target: [deviceFlowLimits.tenant_id, deviceFlowLimits.key],
          set: { attempts: sql`${deviceFlowLimits.attempts} + 1` },
        })
        .returning({ attempts: deviceFlowLimits.attempts });
      return row!.attempts;
    },
    async cleanup(olderThan) {
      let total = 0;
      // Bound each RETURNING result for D1.
      for (const table of [deviceCodes, deviceFlowLimits]) {
        for (;;) {
          const rows = await db
            .delete(table)
            .where(
              sql`rowid IN (SELECT rowid FROM ${table} WHERE ${table.expires_at} < ${olderThan} LIMIT 500)`,
            )
            .returning({ tenant_id: table.tenant_id });
          total += rows.length;
          if (rows.length < 500) break;
        }
      }
      return total;
    },
  };
}
