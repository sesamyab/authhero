import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const migrationSources = sqliteTable(
  "migration_sources",
  {
    id: text("id", { length: 64 }).primaryKey(),
    tenant_id: text("tenant_id", { length: 191 }).notNull(),
    name: text("name", { length: 255 }).notNull(),
    provider: text("provider", { length: 32 }).notNull(),
    connection: text("connection", { length: 255 }).notNull(),
    enabled: integer("enabled").notNull(),
    credentials: text("credentials").notNull(),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [index("idx_migration_sources_tenant_id").on(table.tenant_id)],
);
