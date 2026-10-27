import { z } from "@hono/zod-openapi";

export const deviceCodeSchema = z.object({
  device_code_hash: z.string(),
  user_code_hash: z.string(),
  client_id: z.string(),
  scope: z.string().optional(),
  audience: z.string().optional(),
  status: z.enum(["pending", "approved", "denied", "consumed"]),
  // The approving browser's login, populated only after authentication + MFA/hooks.
  login_id: z.string().optional(),
  expires_at: z.string(),
  created_at: z.string(),
  last_polled_at: z.string().optional(),
  interval: z.number().int().positive(),
  version: z.number().int().nonnegative(),
});
export type DeviceCode = z.infer<typeof deviceCodeSchema>;
export type DeviceCodePatch = Partial<
  Pick<DeviceCode, "status" | "login_id" | "last_polled_at" | "interval">
>;
