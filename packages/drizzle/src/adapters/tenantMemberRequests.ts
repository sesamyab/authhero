import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  tenantMemberRequestInsertSchema,
  tenantMemberRequestSchema,
  type ListTenantMemberRequestsParams,
  type ListTenantMemberRequestsResult,
  type TenantMemberRequest,
  type TenantMemberRequestInsert,
  type TenantMemberRequestUpdate,
  type TenantMemberRequestsAdapter,
} from "@authhero/adapter-interfaces";
import { tenantMemberRequests } from "../schema/sqlite/tenantMemberRequests";
import type { DrizzleDb } from "./types";

function parseJsonColumn(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToRequest(
  row: typeof tenantMemberRequests.$inferSelect,
): TenantMemberRequest {
  return tenantMemberRequestSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    status: row.status,
    requested_by: row.requested_by,
    payload: parseJsonColumn(row.payload) ?? {},
    result: parseJsonColumn(row.result),
    error: row.error,
    notified_at: row.notified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  });
}

export function createTenantMemberRequestsAdapter(
  db: DrizzleDb,
): TenantMemberRequestsAdapter {
  return {
    async create(tenantId: string, request: TenantMemberRequestInsert) {
      const input = tenantMemberRequestInsertSchema.parse(request);
      const now = new Date().toISOString();
      const row: typeof tenantMemberRequests.$inferInsert = {
        tenant_id: tenantId,
        id: `tmr_${nanoid()}`,
        kind: input.kind,
        status: "pending",
        requested_by: input.requested_by,
        payload: JSON.stringify(input.payload),
        result: null,
        error: null,
        notified_at: null,
        created_at: now,
        updated_at: now,
        finished_at: null,
      };
      await db.insert(tenantMemberRequests).values(row);
      return rowToRequest(row as typeof tenantMemberRequests.$inferSelect);
    },

    async get(tenantId: string, id: string) {
      const row = await db
        .select()
        .from(tenantMemberRequests)
        .where(
          and(
            eq(tenantMemberRequests.tenant_id, tenantId),
            eq(tenantMemberRequests.id, id),
          ),
        )
        .get();
      return row ? rowToRequest(row) : null;
    },

    async list(
      tenantId: string,
      params: ListTenantMemberRequestsParams = {},
    ): Promise<ListTenantMemberRequestsResult> {
      const page = params.page ?? 0;
      const per_page = params.per_page ?? 50;

      const conditions: SQL[] = [eq(tenantMemberRequests.tenant_id, tenantId)];
      if (params.status !== undefined) {
        const statuses = Array.isArray(params.status)
          ? params.status
          : [params.status];
        conditions.push(inArray(tenantMemberRequests.status, statuses));
      }
      if (params.unnotified) {
        conditions.push(isNull(tenantMemberRequests.notified_at));
      }
      if (params.created_before) {
        conditions.push(
          lt(tenantMemberRequests.created_at, params.created_before),
        );
      }

      const rows = await db
        .select()
        .from(tenantMemberRequests)
        .where(and(...conditions))
        .orderBy(
          desc(tenantMemberRequests.created_at),
          desc(tenantMemberRequests.id),
        )
        .offset(page * per_page)
        .limit(per_page);

      return {
        requests: rows.map(rowToRequest),
        start: page * per_page,
        limit: per_page,
        length: rows.length,
      };
    },

    async update(
      tenantId: string,
      id: string,
      patch: TenantMemberRequestUpdate,
      expectedStatus?,
    ) {
      const set: Partial<typeof tenantMemberRequests.$inferInsert> = {
        updated_at: new Date().toISOString(),
      };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.result !== undefined)
        set.result = patch.result ? JSON.stringify(patch.result) : null;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.notified_at !== undefined) set.notified_at = patch.notified_at;
      if (patch.finished_at !== undefined) set.finished_at = patch.finished_at;

      const conditions: SQL[] = [
        eq(tenantMemberRequests.tenant_id, tenantId),
        eq(tenantMemberRequests.id, id),
      ];
      if (expectedStatus !== undefined) {
        conditions.push(eq(tenantMemberRequests.status, expectedStatus));
      }

      const rows = await db
        .update(tenantMemberRequests)
        .set(set)
        .where(and(...conditions))
        .returning({ id: tenantMemberRequests.id });
      return rows.length === 1;
    },

    async cleanup(olderThan: string) {
      let total = 0;
      // Bound each RETURNING result for D1.
      for (;;) {
        const rows = await db
          .delete(tenantMemberRequests)
          .where(
            sql`rowid IN (SELECT rowid FROM ${tenantMemberRequests} WHERE ${isNotNull(tenantMemberRequests.finished_at)} AND ${tenantMemberRequests.finished_at} < ${olderThan} LIMIT 500)`,
          )
          .returning({ id: tenantMemberRequests.id });
        total += rows.length;
        if (rows.length < 500) break;
      }
      return total;
    },
  };
}
