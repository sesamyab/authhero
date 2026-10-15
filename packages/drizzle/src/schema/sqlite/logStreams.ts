import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const logStreams = sqliteTable(
  "log_streams",
  {
    id: text("id", { length: 64 }).primaryKey(),
    tenant_id: text("tenant_id", { length: 191 }).notNull(),
    name: text("name", { length: 255 }).notNull(),
    type: text("type", { length: 64 }).notNull(),
    status: text("status", { length: 32 }).notNull(),
    sink: text("sink").notNull(),
    filters: text("filters"),
    is_priority: integer("is_priority"),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [index("idx_log_streams_tenant_id").on(table.tenant_id)],
);
