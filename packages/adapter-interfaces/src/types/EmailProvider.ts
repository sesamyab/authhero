import { z } from "@hono/zod-openapi";
import { configInheritanceShape } from "./ConfigInheritance";

// Accepts every credential shape the auth0 terraform provider sends — SES,
// SMTP, mailgun, sendgrid, sparkpost, mandrill, ms365 — without enforcing
// per-provider required fields here. The sending layer validates by `name`.
export const emailProviderSchema = z.object({
  ...configInheritanceShape,
  name: z.string(),
  enabled: z.boolean().optional().default(true),
  default_from_address: z.string().optional(),
  credentials: z.record(z.string(), z.unknown()),
  settings: z.object({}).optional(),
});

export type EmailProvider = z.infer<typeof emailProviderSchema>;
