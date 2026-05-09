import { z } from "@hono/zod-openapi";

export const emailTemplateNameSchema = z.enum([
  "verify_email",
  "verify_email_by_code",
  "reset_email",
  "reset_email_by_code",
  "welcome_email",
  "blocked_account",
  "stolen_credentials",
  "enrollment_email",
  "mfa_oob_code",
  "change_password",
  "password_reset",
  "user_invitation",
]);

export type EmailTemplateName = z.infer<typeof emailTemplateNameSchema>;

export const emailTemplateSchema = z.object({
  template: emailTemplateNameSchema,
  body: z.string(),
  from: z.string(),
  subject: z.string(),
  syntax: z.literal("liquid").default("liquid"),
  resultUrl: z.string().optional(),
  urlLifetimeInSeconds: z.number().int().nonnegative().optional(),
  includeEmailInRedirect: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export type EmailTemplate = z.infer<typeof emailTemplateSchema>;
