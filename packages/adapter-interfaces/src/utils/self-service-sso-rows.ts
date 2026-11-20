import { z } from "@hono/zod-openapi";
import {
  SelfServiceProfile,
  SelfServiceProfileCustomText,
  SelfServiceProfileUpdate,
  selfServiceProfileBrandingSchema,
  selfServiceProfileCustomTextSchema,
  selfServiceProfileStrategySchema,
  selfServiceProfileUserAttributeSchema,
} from "../types/SelfServiceProfile";
import {
  SsoAccessTicket,
  SsoAccessTicketInsert,
  ssoTicketConnectionConfigSchema,
  ssoTicketDomainVerificationSchema,
  ssoTicketEnabledOrganizationSchema,
} from "../types/SsoAccessTicket";
import {
  ConnectionDomain,
  connectionDomainStatusSchema,
} from "../types/ConnectionDomain";

/**
 * Row mapping shared by the SQL adapters (drizzle, kysely) for the
 * Self-Service SSO tables (#1763). Structured fields are stored as JSON text;
 * a value that no longer parses reads back as absent rather than throwing.
 */

function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | undefined {
  if (!raw) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export type SelfServiceProfileRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  allowed_strategies: string | null;
  user_attributes: string | null;
  branding: string | null;
  created_at: string;
  updated_at: string;
};

export function selfServiceProfileFromRow(
  row: SelfServiceProfileRow,
): SelfServiceProfile {
  const profile: SelfServiceProfile = {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.description !== null) profile.description = row.description;
  const allowedStrategies = parseJson(
    row.allowed_strategies,
    z.array(selfServiceProfileStrategySchema),
  );
  if (allowedStrategies) profile.allowed_strategies = allowedStrategies;
  const userAttributes = parseJson(
    row.user_attributes,
    z.array(selfServiceProfileUserAttributeSchema),
  );
  if (userAttributes) profile.user_attributes = userAttributes;
  const branding = parseJson(row.branding, selfServiceProfileBrandingSchema);
  if (branding) profile.branding = branding;
  return profile;
}

/** The columns a profile update writes; `null` clears a column. */
export function selfServiceProfileUpdateToRow(
  update: SelfServiceProfileUpdate,
  now: string,
): Partial<SelfServiceProfileRow> {
  const set: Partial<SelfServiceProfileRow> = { updated_at: now };
  if (update.name !== undefined) set.name = update.name;
  if (update.description !== undefined) set.description = update.description;
  if (update.allowed_strategies !== undefined)
    set.allowed_strategies = jsonOrNull(update.allowed_strategies);
  if (update.user_attributes !== undefined)
    set.user_attributes = jsonOrNull(update.user_attributes);
  if (update.branding !== undefined) set.branding = jsonOrNull(update.branding);
  return set;
}

export function selfServiceProfileCustomTextFromJson(
  raw: string | null,
): SelfServiceProfileCustomText {
  return parseJson(raw, selfServiceProfileCustomTextSchema) ?? {};
}

export type SsoAccessTicketRow = {
  id: string;
  tenant_id: string;
  profile_id: string;
  ticket_hash: string;
  connection_id: string | null;
  connection_config: string | null;
  enabled_clients: string | null;
  enabled_organizations: string | null;
  domain_verification: string;
  expires_at: string;
  revoked_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export function ssoAccessTicketToRow(
  tenant_id: string,
  id: string,
  ticket: SsoAccessTicketInsert,
  now: string,
): SsoAccessTicketRow {
  return {
    id,
    tenant_id,
    profile_id: ticket.profile_id,
    ticket_hash: ticket.ticket_hash,
    connection_id: ticket.connection_id ?? null,
    connection_config: jsonOrNull(ticket.connection_config),
    enabled_clients: JSON.stringify(ticket.enabled_clients ?? []),
    enabled_organizations: JSON.stringify(ticket.enabled_organizations ?? []),
    domain_verification: ticket.domain_verification,
    expires_at: ticket.expires_at,
    revoked_at: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * The stored ticket, without its hash. An unreadable `domain_verification`
 * reads back as `required`, the strictest mode.
 */
export function ssoAccessTicketFromRow(
  row: SsoAccessTicketRow,
): SsoAccessTicket {
  const domainVerification = ssoTicketDomainVerificationSchema.safeParse(
    row.domain_verification,
  );
  const ticket: SsoAccessTicket = {
    id: row.id,
    profile_id: row.profile_id,
    enabled_clients: parseJson(row.enabled_clients, z.array(z.string())) ?? [],
    enabled_organizations:
      parseJson(
        row.enabled_organizations,
        z.array(ssoTicketEnabledOrganizationSchema),
      ) ?? [],
    domain_verification: domainVerification.success
      ? domainVerification.data
      : "required",
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.connection_id !== null) ticket.connection_id = row.connection_id;
  const connectionConfig = parseJson(
    row.connection_config,
    ssoTicketConnectionConfigSchema,
  );
  if (connectionConfig) ticket.connection_config = connectionConfig;
  if (row.revoked_at !== null) ticket.revoked_at = row.revoked_at;
  if (row.completed_at !== null) ticket.completed_at = row.completed_at;
  return ticket;
}

export type ConnectionDomainRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  domain: string;
  status: string;
  verification_value: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Domains are stored and matched lowercased. */
export function normalizeConnectionDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/** An unreadable `status` reads back as `pending`, i.e. not trusted. */
export function connectionDomainFromRow(
  row: ConnectionDomainRow,
): ConnectionDomain {
  const status = connectionDomainStatusSchema.safeParse(row.status);
  const domain: ConnectionDomain = {
    id: row.id,
    connection_id: row.connection_id,
    domain: row.domain,
    status: status.success ? status.data : "pending",
    verification_value: row.verification_value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.verified_at !== null) domain.verified_at = row.verified_at;
  return domain;
}
