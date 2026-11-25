import { z } from "@hono/zod-openapi";

/**
 * Self-Service SSO access tickets (Auth0-compatible, issue #1763).
 *
 * A ticket is the only credential of an outside admin setting up one SSO
 * connection: a URL carrying a random ticket id, with no account and no login.
 * The ticket id is a bearer value, so it is returned once (inside the URL) and
 * stored only as a hash (`ticket_hash`). The Management API's `revoke` hashes
 * the id from its path to find the row. The stored ticket never exposes the
 * hash.
 *
 * A ticket stays usable until it expires or is revoked; finishing the setup
 * (`completed_at`) does not end it, so the admin can come back to rotate a
 * secret or replace a certificate.
 */

/** Auth0's `domain_aliases_config.domain_verification` modes. */
export const SSO_TICKET_DOMAIN_VERIFICATION_MODES = [
  "none",
  "optional",
  "required",
] as const;
export const ssoTicketDomainVerificationSchema = z.enum(
  SSO_TICKET_DOMAIN_VERIFICATION_MODES,
);
export type SsoTicketDomainVerification = z.infer<
  typeof ssoTicketDomainVerificationSchema
>;

/** The parts of Auth0's `connection_config.options` AuthHero supports. */
export const ssoTicketConnectionOptionsSchema = z.object({
  icon_url: z.string().optional(),
  domain_aliases: z.array(z.string()).optional(),
});

/**
 * The connection a "create" ticket sets up. The strategy is not part of it:
 * the outside admin picks one of the profile's `allowed_strategies`.
 */
export const ssoTicketConnectionConfigSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  is_domain_connection: z.boolean().optional(),
  show_as_button: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  options: ssoTicketConnectionOptionsSchema.optional(),
});
export type SsoTicketConnectionConfig = z.infer<
  typeof ssoTicketConnectionConfigSchema
>;

export const ssoTicketEnabledOrganizationSchema = z.object({
  organization_id: z.string(),
  assign_membership_on_login: z.boolean().optional(),
  show_as_button: z.boolean().optional(),
});
export type SsoTicketEnabledOrganization = z.infer<
  typeof ssoTicketEnabledOrganizationSchema
>;

export const ssoAccessTicketSchema = z.object({
  /** Internal row id; used as the actor in logs, never in the ticket URL. */
  id: z.string(),
  profile_id: z.string(),
  /**
   * The ticket's single connection: set at creation for an "edit" ticket, or
   * when a "create" ticket's connection is first saved.
   */
  connection_id: z.string().optional(),
  /** Set for a "create" ticket. */
  connection_config: ssoTicketConnectionConfigSchema.optional(),
  enabled_clients: z.array(z.string()),
  enabled_organizations: z.array(ssoTicketEnabledOrganizationSchema),
  domain_verification: ssoTicketDomainVerificationSchema,
  expires_at: z.string(),
  revoked_at: z.string().optional(),
  completed_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SsoAccessTicket = z.infer<typeof ssoAccessTicketSchema>;

export type SsoAccessTicketInsert = {
  profile_id: string;
  /** Hash of the ticket id (the bearer value in the URL). */
  ticket_hash: string;
  connection_id?: string;
  connection_config?: SsoTicketConnectionConfig;
  enabled_clients?: string[];
  enabled_organizations?: SsoTicketEnabledOrganization[];
  domain_verification: SsoTicketDomainVerification;
  expires_at: string;
};

/** The fields that change over a ticket's life. */
export type SsoAccessTicketUpdate = {
  connection_id?: string;
  revoked_at?: string;
  completed_at?: string;
};
