import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

export const deviceCodes = sqliteTable(
  "device_codes",
  {
    tenant_id: text("tenant_id").notNull(),
    device_code_hash: text("device_code_hash").notNull(),
    user_code_hash: text("user_code_hash").notNull(),
    client_id: text("client_id").notNull(),
    scope: text("scope"),
    audience: text("audience"),
    status: text("status").notNull(),
    login_id: text("login_id"),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull(),
    last_polled_at: text("last_polled_at"),
    interval: integer("interval").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.device_code_hash] }),
    uniqueIndex("device_codes_user_code_idx").on(t.tenant_id, t.user_code_hash),
    index("device_codes_expiry_idx").on(t.expires_at),
  ],
);

export const deviceFlowLimits = sqliteTable(
  "device_flow_limits",
  {
    tenant_id: text("tenant_id").notNull(),
    key: text("key").notNull(),
    attempts: integer("attempts").notNull(),
    expires_at: text("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.key] }),
    index("device_flow_limits_expiry_idx").on(t.expires_at),
  ],
);
