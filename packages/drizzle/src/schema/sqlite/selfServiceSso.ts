import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants";

// Self-Service SSO (#1763): profiles (with their custom text) and SSO access
// tickets. Every row cascades from its tenant, and tickets from their profile,
// so a ticket inserted while its profile is being deleted cannot outlive it.
// A self-service connection's email domains live on the connection
// (`connections.self_service`).

const tenantId = () =>
  text("tenant_id", { length: 191 })
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

export const selfServiceProfiles = sqliteTable(
  "self_service_profiles",
  {
    id: text("id", { length: 64 }).primaryKey(),
    tenant_id: tenantId(),
    name: text("name", { length: 255 }).notNull(),
    description: text("description", { length: 255 }),
    // JSON arrays/objects.
    allowed_strategies: text("allowed_strategies"),
    user_attributes: text("user_attributes"),
    branding: text("branding"),
    // JSON: language → page → custom text (Auth0: `en` / `get-started`).
    custom_text: text("custom_text"),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [index("self_service_profiles_tenant_id_idx").on(table.tenant_id)],
);

// The ticket id is the bearer value in the ticket URL and is never stored:
// only its hash, which is unique so a hash resolves to one ticket.
export const ssoAccessTickets = sqliteTable(
  "sso_access_tickets",
  {
    id: text("id", { length: 64 }).primaryKey(),
    tenant_id: tenantId(),
    profile_id: text("profile_id", { length: 64 })
      .notNull()
      .references(() => selfServiceProfiles.id, { onDelete: "cascade" }),
    ticket_hash: text("ticket_hash", { length: 128 }).notNull(),
    connection_id: text("connection_id", { length: 255 }),
    // JSON.
    connection_config: text("connection_config"),
    enabled_clients: text("enabled_clients"),
    enabled_organizations: text("enabled_organizations"),
    domain_verification: text("domain_verification", { length: 16 }).notNull(),
    expires_at: text("expires_at", { length: 35 }).notNull(),
    revoked_at: text("revoked_at", { length: 35 }),
    completed_at: text("completed_at", { length: 35 }),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [
    uniqueIndex("sso_access_tickets_ticket_hash_idx").on(table.ticket_hash),
    index("sso_access_tickets_tenant_profile_idx").on(
      table.tenant_id,
      table.profile_id,
    ),
  ],
);
