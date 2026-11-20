import { z } from "@hono/zod-openapi";

/**
 * An email domain claimed by a connection and its DNS verification state
 * (Self-Service SSO, issue #1763).
 *
 * The outside admin proves control of a domain by publishing a TXT record
 * with `verification_value`. The value is random per domain; it is published
 * in DNS, so it is not a secret.
 *
 * These rows are the verification workflow. What login trusts is the
 * projection on the connection: verified domains are copied into
 * `connection.self_service.domains` (the account-linking guard) and
 * `connection.options.domain_aliases` (home-realm discovery).
 *
 * Several connections may hold a `pending` claim on the same domain, so a
 * claim that is never verified cannot block the domain's real owner. Refusing
 * a domain already verified for another connection is the caller's check.
 * Domains are stored lowercased.
 */
export const CONNECTION_DOMAIN_STATUSES = ["pending", "verified"] as const;
export const connectionDomainStatusSchema = z.enum(CONNECTION_DOMAIN_STATUSES);
export type ConnectionDomainStatus = z.infer<
  typeof connectionDomainStatusSchema
>;

export const connectionDomainSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  domain: z.string(),
  status: connectionDomainStatusSchema,
  /** The TXT record value that proves control of the domain. */
  verification_value: z.string(),
  verified_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConnectionDomain = z.infer<typeof connectionDomainSchema>;

export type ConnectionDomainInsert = {
  connection_id: string;
  domain: string;
  verification_value: string;
  status?: ConnectionDomainStatus;
  verified_at?: string;
};

export type ConnectionDomainUpdate = {
  status?: ConnectionDomainStatus;
  verification_value?: string;
  /** `null` clears it, e.g. when a domain falls back to `pending`. */
  verified_at?: string | null;
};

export type ListConnectionDomainsParams = {
  connection_id?: string;
  domain?: string;
};
