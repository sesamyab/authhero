import { sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";

export const tenantMemberRequests = sqliteTable(
  "tenant_member_requests",
  {
    tenant_id: text("tenant_id").notNull(),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    requested_by: text("requested_by").notNull(),
    payload: text("payload").notNull(),
    result: text("result"),
    error: text("error"),
    notified_at: text("notified_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    finished_at: text("finished_at"),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("tenant_member_requests_status_idx").on(
      t.tenant_id,
      t.status,
      t.created_at,
    ),
    index("tenant_member_requests_finished_idx").on(t.finished_at),
  ],
);
