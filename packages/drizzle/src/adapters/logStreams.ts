import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  CreateOptions,
  LogStream,
  LogStreamInsert,
  LogStreamsAdapter,
} from "@authhero/adapter-interfaces";
import { logStreams } from "../schema/sqlite";
import type { DrizzleDb } from "./types";

type Row = typeof logStreams.$inferSelect;

function fromRow(row: Row): LogStream {
  return {
    id: row.id,
    name: row.name,
    type: row.type as LogStream["type"],
    status: row.status as LogStream["status"],
    sink: JSON.parse(row.sink),
    filters: row.filters ? JSON.parse(row.filters) : undefined,
    isPriority: row.is_priority == null ? undefined : row.is_priority === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createLogStreamsAdapter(db: DrizzleDb): LogStreamsAdapter {
  return {
    async create(
      tenant_id: string,
      params: LogStreamInsert,
      options?: CreateOptions,
    ): Promise<LogStream> {
      const importMetadata = options?.importMetadata;
      const now = new Date().toISOString();
      const row: Row = {
        id: importMetadata?.id ?? `lst_${nanoid()}`,
        tenant_id,
        name: params.name,
        type: params.type,
        status: params.status ?? "active",
        sink: JSON.stringify(params.sink),
        filters: params.filters ? JSON.stringify(params.filters) : null,
        is_priority:
          params.isPriority === undefined ? null : params.isPriority ? 1 : 0,
        created_at: importMetadata?.created_at ?? now,
        updated_at: importMetadata?.updated_at ?? now,
      };
      await db.insert(logStreams).values(row);
      return fromRow(row);
    },

    async get(tenant_id: string, id: string) {
      const row = await db
        .select()
        .from(logStreams)
        .where(and(eq(logStreams.tenant_id, tenant_id), eq(logStreams.id, id)))
        .get();
      return row ? fromRow(row) : null;
    },

    async list(tenant_id: string) {
      const rows = await db
        .select()
        .from(logStreams)
        .where(eq(logStreams.tenant_id, tenant_id))
        .all();
      return rows.map(fromRow);
    },

    async update(tenant_id: string, id: string, params) {
      const patch: Partial<Row> = { updated_at: new Date().toISOString() };
      if (params.name !== undefined) patch.name = params.name;
      if (params.type !== undefined) patch.type = params.type;
      if (params.status !== undefined) patch.status = params.status;
      if (params.sink !== undefined) patch.sink = JSON.stringify(params.sink);
      if (params.filters !== undefined) {
        patch.filters = params.filters ? JSON.stringify(params.filters) : null;
      }
      if (params.isPriority !== undefined) {
        patch.is_priority = params.isPriority ? 1 : 0;
      }
      const updated = await db
        .update(logStreams)
        .set(patch)
        .where(and(eq(logStreams.tenant_id, tenant_id), eq(logStreams.id, id)))
        .returning({ id: logStreams.id });
      return updated.length > 0;
    },

    async remove(tenant_id: string, id: string) {
      const deleted = await db
        .delete(logStreams)
        .where(and(eq(logStreams.tenant_id, tenant_id), eq(logStreams.id, id)))
        .returning({ id: logStreams.id });
      return deleted.length > 0;
    },
  };
}
