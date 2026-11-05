import { z } from "@hono/zod-openapi";
import { deviceSchema } from "./Device";

export const sessionAuthenticationMethodSchema = z.object({
  name: z
    .string()
    .describe(
      'Authentication method name, e.g. "mfa" for a completed second factor',
    ),
  timestamp: z.string().describe("When the method was completed (ISO 8601)"),
  type: z
    .string()
    .optional()
    .describe(
      'For "mfa": the authentication method type used, e.g. "totp", "phone", "passkey"',
    ),
});

export type SessionAuthenticationMethod = z.infer<
  typeof sessionAuthenticationMethodSchema
>;

export const sessionAuthenticationSchema = z.object({
  methods: z.array(sessionAuthenticationMethodSchema),
});

export type SessionAuthentication = z.infer<typeof sessionAuthenticationSchema>;

export const sessionInsertSchema = z.object({
  id: z.string(),
  revoked_at: z.string().optional(),
  used_at: z.string().optional(),
  user_id: z.string().describe("The user ID associated with the session"),
  expires_at: z.string().optional(),
  login_session_id: z.string(),
  idle_expires_at: z.string().optional(),
  device: deviceSchema.describe(
    "Metadata related to the device used in the session",
  ),
  clients: z
    .array(z.string())
    .describe("List of client details for the session"),
  authentication: sessionAuthenticationSchema
    .optional()
    .describe(
      "Authentication methods completed in this session (currently MFA only)",
    ),
});

export type SessionInsert = z.infer<typeof sessionInsertSchema>;

export const sessionSchema = z
  .object({
    created_at: z.string(),
    updated_at: z.string(),
    authenticated_at: z.string(),
    last_interaction_at: z.string(),
  })
  .extend(sessionInsertSchema.shape);

export type Session = z.infer<typeof sessionSchema>;
