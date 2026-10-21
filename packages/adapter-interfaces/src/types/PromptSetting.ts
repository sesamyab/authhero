import { z } from "@hono/zod-openapi";
import { configInheritanceShape } from "./ConfigInheritance";

export const promptSettingSchema = z.object({
  ...configInheritanceShape,
  universal_login_experience: z.enum(["new", "classic"]).default("new"),
  identifier_first: z.boolean().default(true),
  password_first: z.boolean().default(false),
  // Opt-in: writes a device cookie with the last successfully used connection
  // and renders a "Last used" hint on the identifier/login screens.
  show_last_used_connection: z.boolean().default(false),
  webauthn_platform_first_factor: z.boolean(),
});

export type PromptSetting = z.infer<typeof promptSettingSchema>;
