import { z } from "@hono/zod-openapi";

export const sessionTransferAuthenticationMethodSchema = z.enum([
  "cookie",
  "query",
]);
export type SessionTransferAuthenticationMethod = z.infer<
  typeof sessionTransferAuthenticationMethodSchema
>;

export const sessionTransferDeviceBindingSchema = z.enum(["ip", "asn", "none"]);
export type SessionTransferDeviceBinding = z.infer<
  typeof sessionTransferDeviceBindingSchema
>;

/**
 * `client.session_transfer`: Auth0's Native to Web SSO settings, plus two
 * AuthHero extensions (`allow_onward_transfer`, `trust_forwarded_ip`).
 *
 * The first two Auth0 fields and both extensions are read on the client that
 * mints a session_transfer_token; the remaining four are read on the client
 * that redeems one at /authorize.
 *
 * Every field is optional here on purpose. Clients that never configured the
 * feature are stored as `{}`, and a zod-level default would both make the
 * stored shape differ from the parsed one and be re-applied by every
 * `.partial()` PATCH that omits the field. Read the effective settings with
 * `resolveSessionTransfer`, which applies `SESSION_TRANSFER_DEFAULTS`.
 */
export const sessionTransferSchema = z
  .object({
    can_create_session_transfer_token: z.boolean().optional().openapi({
      default: false,
      description:
        "Whether this client may exchange a refresh token for a session_transfer_token.",
    }),
    enforce_cascade_revocation: z.boolean().optional().openapi({
      default: true,
      description:
        "Whether revoking the refresh token a session_transfer_token was minted from also ends the sessions (and their refresh tokens) created with that token.",
    }),
    allowed_authentication_methods: z
      .array(sessionTransferAuthenticationMethodSchema)
      .optional()
      .openapi({
        default: [],
        description:
          "How this client accepts a session_transfer_token at /authorize: as the `session_transfer_token` query parameter (`query`) and/or the `auth0_session_transfer_token` cookie (`cookie`). Empty means the client does not accept session transfer.",
      }),
    enforce_device_binding: sessionTransferDeviceBindingSchema
      .optional()
      .openapi({
        default: "ip",
        description:
          "Whether the browser redeeming a session_transfer_token must come from the same IP address (`ip`) or autonomous system (`asn`) as the request that minted it. `none` disables the check.",
      }),
    allow_refresh_token: z.boolean().optional().openapi({
      default: false,
      description:
        "Whether a login established with a session_transfer_token may be issued a refresh token.",
    }),
    enforce_online_refresh_tokens: z.boolean().optional().openapi({
      default: true,
      description:
        "Whether refresh tokens issued on a transferred session are bound to that session's lifetime.",
    }),
    allow_onward_transfer: z.boolean().optional().openapi({
      default: false,
      description:
        "AuthHero extension. Whether this client may mint a session_transfer_token from a login that was itself established with one (A → B → C). The onward token stays tied to the original refresh token.",
    }),
    trust_forwarded_ip: z.boolean().optional().openapi({
      default: false,
      description:
        "AuthHero extension. Whether an authenticated confidential client may pass the end user's IP address in the `auth0-forwarded-for` header when minting, so device binding compares against the browser rather than the client's backend. Ignored for requests without client authentication.",
    }),
  })
  .passthrough();

export type SessionTransfer = z.infer<typeof sessionTransferSchema>;

/** The effective settings: every known field present. */
export interface ResolvedSessionTransfer {
  can_create_session_transfer_token: boolean;
  enforce_cascade_revocation: boolean;
  allowed_authentication_methods: SessionTransferAuthenticationMethod[];
  enforce_device_binding: SessionTransferDeviceBinding;
  allow_refresh_token: boolean;
  enforce_online_refresh_tokens: boolean;
  allow_onward_transfer: boolean;
  trust_forwarded_ip: boolean;
}

/**
 * Auth0's defaults for the six Auth0 fields; both extensions default to off.
 */
export const SESSION_TRANSFER_DEFAULTS: Readonly<ResolvedSessionTransfer> = {
  can_create_session_transfer_token: false,
  enforce_cascade_revocation: true,
  allowed_authentication_methods: [],
  enforce_device_binding: "ip",
  allow_refresh_token: false,
  enforce_online_refresh_tokens: true,
  allow_onward_transfer: false,
  trust_forwarded_ip: false,
};

/**
 * Apply the defaults to a stored `client.session_transfer`. A stored value that
 * does not validate (hand-edited row, older shape) resolves to the defaults,
 * which leave the feature off, rather than throwing in the middle of a login.
 */
export function resolveSessionTransfer(
  value: unknown,
): ResolvedSessionTransfer {
  const parsed = sessionTransferSchema.safeParse(value ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    can_create_session_transfer_token:
      stored.can_create_session_transfer_token ??
      SESSION_TRANSFER_DEFAULTS.can_create_session_transfer_token,
    enforce_cascade_revocation:
      stored.enforce_cascade_revocation ??
      SESSION_TRANSFER_DEFAULTS.enforce_cascade_revocation,
    allowed_authentication_methods: stored.allowed_authentication_methods ?? [
      ...SESSION_TRANSFER_DEFAULTS.allowed_authentication_methods,
    ],
    enforce_device_binding:
      stored.enforce_device_binding ??
      SESSION_TRANSFER_DEFAULTS.enforce_device_binding,
    allow_refresh_token:
      stored.allow_refresh_token ??
      SESSION_TRANSFER_DEFAULTS.allow_refresh_token,
    enforce_online_refresh_tokens:
      stored.enforce_online_refresh_tokens ??
      SESSION_TRANSFER_DEFAULTS.enforce_online_refresh_tokens,
    allow_onward_transfer:
      stored.allow_onward_transfer ??
      SESSION_TRANSFER_DEFAULTS.allow_onward_transfer,
    trust_forwarded_ip:
      stored.trust_forwarded_ip ?? SESSION_TRANSFER_DEFAULTS.trust_forwarded_ip,
  };
}

/**
 * Provenance recorded on a session that was created by redeeming a
 * session_transfer_token, and on every refresh token issued under it.
 */
export const sessionTransferProvenanceSchema = z.object({
  client_id: z
    .string()
    .describe("The client that minted the session_transfer_token"),
  family_id: z
    .string()
    .describe(
      "Rotation family of the refresh token the session_transfer_token was minted from. The family id is stable across rotation, the row id is not.",
    ),
  cascade_revocation: z
    .boolean()
    .describe(
      "Whether this session ends when the parent refresh token family is no longer active",
    ),
});

export type SessionTransferProvenance = z.infer<
  typeof sessionTransferProvenanceSchema
>;
