import { Kysely } from "kysely";
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
import type { Database } from "../db";

type RequestRow = Database["tenant_member_requests"];

function parseJsonColumn(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToRequest(row: RequestRow): TenantMemberRequest {
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
  db: Kysely<Database>,
): TenantMemberRequestsAdapter {
  return {
    async create(tenantId: string, request: TenantMemberRequestInsert) {
      const input = tenantMemberRequestInsertSchema.parse(request);
      const now = new Date().toISOString();
      const row: RequestRow = {
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
      await db.insertInto("tenant_member_requests").values(row).execute();
      return rowToRequest(row);
    },

    async get(tenantId: string, id: string) {
      const row = await db
        .selectFrom("tenant_member_requests")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? rowToRequest(row) : null;
    },

    async list(
      tenantId: string,
      params: ListTenantMemberRequestsParams = {},
    ): Promise<ListTenantMemberRequestsResult> {
      const page = params.page ?? 0;
      const per_page = params.per_page ?? 50;

      let query = db
        .selectFrom("tenant_member_requests")
        .selectAll()
        .where("tenant_id", "=", tenantId);
      if (params.status !== undefined) {
        const statuses = Array.isArray(params.status)
          ? params.status
          : [params.status];
        query = query.where("status", "in", statuses);
      }
      if (params.unnotified) query = query.where("notified_at", "is", null);
      if (params.created_before) {
        query = query.where("created_at", "<", params.created_before);
      }

      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .offset(page * per_page)
        .limit(per_page)
        .execute();

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
      const now = new Date().toISOString();
      const set: Partial<RequestRow> = {
        updated_at: now,
      };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.result !== undefined)
        set.result = patch.result ? JSON.stringify(patch.result) : null;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.notified_at !== undefined) set.notified_at = patch.notified_at;
      if (patch.finished_at !== undefined) set.finished_at = patch.finished_at;
      // A request that ends without saying when has ended now, or `cleanup`
      // would never remove it.
      else if (patch.status === "succeeded" || patch.status === "failed") {
        set.finished_at = now;
      }

      let query = db
        .updateTable("tenant_member_requests")
        .set(set)
        .where("tenant_id", "=", tenantId)
        .where("id", "=", id);
      if (expectedStatus !== undefined) {
        query = query.where("status", "=", expectedStatus);
      }
      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async cleanup(olderThan: string) {
      const result = await db
        .deleteFrom("tenant_member_requests")
        .where("finished_at", "is not", null)
        .where("finished_at", "<", olderThan)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
