import { z } from "@hono/zod-openapi";

/**
 * Self-Service SSO (Auth0-compatible, issue #1763).
 *
 * A self-service profile defines what an outside admin may set up through an
 * SSO access ticket: the identity provider types offered, the user attributes
 * the connection must provide, and the branding of the setup assistant.
 */

/** Every strategy Auth0 accepts in `allowed_strategies`. */
export const SELF_SERVICE_PROFILE_STRATEGIES = [
  "oidc",
  "samlp",
  "waad",
  "google-apps",
  "adfs",
  "okta",
  "auth0-samlp",
  "okta-samlp",
  "keycloak-samlp",
  "pingfederate",
] as const;

/**
 * The strategies AuthHero can set up through Self-Service SSO today. The
 * Management API rejects the others with a 400 until they are implemented
 * (Okta, Google Workspace, ADFS and PingFederate are planned as OIDC/SAML
 * presets).
 */
export const SUPPORTED_SELF_SERVICE_STRATEGIES = [
  "oidc",
  "samlp",
  "waad",
] as const;

export const selfServiceProfileStrategySchema = z.enum(
  SELF_SERVICE_PROFILE_STRATEGIES,
);
export type SelfServiceProfileStrategy = z.infer<
  typeof selfServiceProfileStrategySchema
>;

export const selfServiceProfileUserAttributeSchema = z.object({
  name: z.string(),
  description: z.string(),
  is_optional: z.boolean(),
});
export type SelfServiceProfileUserAttribute = z.infer<
  typeof selfServiceProfileUserAttributeSchema
>;

export const selfServiceProfileBrandingSchema = z.object({
  logo_url: z.string().optional(),
  colors: z
    .object({
      primary: z.string(),
    })
    .optional(),
});
export type SelfServiceProfileBranding = z.infer<
  typeof selfServiceProfileBrandingSchema
>;

export const selfServiceProfileInsertSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  allowed_strategies: z.array(selfServiceProfileStrategySchema).optional(),
  user_attributes: z.array(selfServiceProfileUserAttributeSchema).optional(),
  branding: selfServiceProfileBrandingSchema.optional(),
});
export type SelfServiceProfileInsert = z.input<
  typeof selfServiceProfileInsertSchema
>;

export const selfServiceProfileSchema = selfServiceProfileInsertSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SelfServiceProfile = z.infer<typeof selfServiceProfileSchema>;

/**
 * A partial update. `null` clears an optional field (Auth0 accepts `null` for
 * `description`, `branding` and `user_attributes` on PATCH).
 */
export type SelfServiceProfileUpdate = {
  name?: string;
  description?: string | null;
  allowed_strategies?: SelfServiceProfileStrategy[];
  user_attributes?: SelfServiceProfileUserAttribute[] | null;
  branding?: SelfServiceProfileBranding | null;
};

/** Auth0's custom-text languages and pages for the setup assistant. */
export const SELF_SERVICE_PROFILE_CUSTOM_TEXT_LANGUAGES = ["en"] as const;
export const SELF_SERVICE_PROFILE_CUSTOM_TEXT_PAGES = ["get-started"] as const;

/** Custom text for one language and page: text key → text. */
export const selfServiceProfileCustomTextSchema = z.record(
  z.string(),
  z.string(),
);
export type SelfServiceProfileCustomText = z.infer<
  typeof selfServiceProfileCustomTextSchema
>;
