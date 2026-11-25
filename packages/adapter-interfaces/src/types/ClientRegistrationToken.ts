import { z } from "@hono/zod-openapi";

export const clientRegistrationTokenTypeSchema = z.enum(["iat", "rat"]);
export type ClientRegistrationTokenType = z.infer<
  typeof clientRegistrationTokenTypeSchema
>;

/**
 * Where a registration token came from:
 * - `invite`: an Initial Access Token minted from an app-type preset, sent to
 *   an outside developer as a setup link
 * - `edit_link`: a Registration Access Token minted for one client so its
 *   developer can update it through the setup page (or RFC 7592)
 * - `registration`: the Registration Access Token returned by
 *   `POST /oidc/register`
 * - `connect`: an Initial Access Token minted by the `/connect/start` consent
 *
 * Unset on rows written before the column existed.
 */
export const clientRegistrationTokenSourceSchema = z.enum([
  "invite",
  "edit_link",
  "registration",
  "connect",
]);
export type ClientRegistrationTokenSource = z.infer<
  typeof clientRegistrationTokenSourceSchema
>;

export const clientRegistrationTokenInsertSchema = z.object({
  id: z.string(),
  token_hash: z.string(),
  type: clientRegistrationTokenTypeSchema,
  client_id: z.string().optional(),
  sub: z.string().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  single_use: z.boolean().default(false),
  expires_at: z.string().optional(),
  /** Operator-facing label, e.g. who an invite is for. */
  name: z.string().optional(),
  /** `sub` of the Management API caller that minted the token. */
  created_by: z.string().optional(),
  source: clientRegistrationTokenSourceSchema.optional(),
});

export type ClientRegistrationTokenInsert = z.infer<
  typeof clientRegistrationTokenInsertSchema
>;

export const clientRegistrationTokenSchema = z
  .object({
    created_at: z.string(),
    used_at: z.string().optional(),
    revoked_at: z.string().optional(),
  })
  .extend(clientRegistrationTokenInsertSchema.shape);

export type ClientRegistrationToken = z.infer<
  typeof clientRegistrationTokenSchema
>;
