import { z } from "@hono/zod-openapi";
import { credentialString } from "../utils/credentials";

export const migrationProviderTypeSchema = z.enum([
  "auth0",
  "cognito",
  "okta",
  "oidc",
]);
export type MigrationProviderType = z.infer<typeof migrationProviderTypeSchema>;

export const migrationSourceCredentialsSchema = z.object({
  domain: z.string(),
  client_id: z.string(),
  client_secret: credentialString(),
  audience: z.string().optional(),
  scope: z.string().optional(),
});
export type MigrationSourceCredentials = z.infer<
  typeof migrationSourceCredentialsSchema
>;

export const migrationSourceInsertSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  provider: migrationProviderTypeSchema,
  connection: z.string(),
  enabled: z.boolean().default(true),
  credentials: migrationSourceCredentialsSchema,
});
export type MigrationSourceInsert = z.infer<typeof migrationSourceInsertSchema>;

export const migrationSourceSchema = z
  .object({
    id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .extend(migrationSourceInsertSchema.shape);

export type MigrationSource = z.infer<typeof migrationSourceSchema>;
