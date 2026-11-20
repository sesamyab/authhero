import {
  index,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants";
import { connections } from "./connections";

// Self-Service SSO (#1763): profiles, their custom text, SSO access tickets
// and connection domains. Every row cascades from its tenant; custom text and
// tickets cascade from their profile (so a ticket inserted while its profile
// is being deleted cannot outlive it), and domain claims from their
// connection.

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
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [index("self_service_profiles_tenant_id_idx").on(table.tenant_id)],
);

export const selfServiceProfileCustomTexts = sqliteTable(
  "self_service_profile_custom_texts",
  {
    tenant_id: tenantId(),
    profile_id: text("profile_id", { length: 64 })
      .notNull()
      .references(() => selfServiceProfiles.id, { onDelete: "cascade" }),
    language: text("language", { length: 32 }).notNull(),
    page: text("page", { length: 64 }).notNull(),
    // JSON object: text key → text.
    custom_text: text("custom_text").notNull(),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenant_id, table.profile_id, table.language, table.page],
      name: "self_service_profile_custom_texts_pk",
    }),
  ],
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

// Several connections may hold a pending claim on one domain (see
// `ConnectionDomain`), so uniqueness is per connection.
export const connectionDomains = sqliteTable(
  "connection_domains",
  {
    id: text("id", { length: 64 }).primaryKey(),
    tenant_id: tenantId(),
    connection_id: text("connection_id", { length: 255 })
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    domain: text("domain", { length: 255 }).notNull(),
    status: text("status", { length: 16 }).notNull(),
    verification_value: text("verification_value", { length: 255 }).notNull(),
    verified_at: text("verified_at", { length: 35 }),
    created_at: text("created_at", { length: 35 }).notNull(),
    updated_at: text("updated_at", { length: 35 }).notNull(),
  },
  (table) => [
    uniqueIndex("connection_domains_tenant_connection_domain_idx").on(
      table.tenant_id,
      table.connection_id,
      table.domain,
    ),
    index("connection_domains_tenant_domain_idx").on(
      table.tenant_id,
      table.domain,
    ),
  ],
);
