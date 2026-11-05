import { z } from "@hono/zod-openapi";

/**
 * The tenant MFA policy (`tenant.mfa.policy`).
 *
 * - `never`: the tenant policy never requires MFA. Post-login actions can still
 *   require it per login with `api.multifactor.enable(...)`.
 * - `always`: MFA is required for every interactive login.
 * - `all-applications`: Auth0's Guardian policy name for `always`; enforced
 *   identically. `PUT /guardian/policies` still stores `always` so bundles that
 *   predate this value can read synced tenants.
 * - `confidence-score`: Auth0's adaptive MFA. Accepted and stored for parity,
 *   but risk scoring is NOT supported: it is enforced like `always`, so MFA is
 *   never skipped on a score we cannot compute.
 */
export const mfaPolicySchema = z.enum([
  "never",
  "always",
  "all-applications",
  "confidence-score",
]);
export type MfaPolicy = z.infer<typeof mfaPolicySchema>;

// Based on Auth0 Management API v2 Tenant Settings
// https://auth0.com/docs/api/management/v2/tenants/tenant-settings-route

export const tenantSettingsSchema = z.object({
  // Session settings
  idle_session_lifetime: z.number().default(72),
  session_lifetime: z.number().default(168),
  session_cookie: z
    .object({
      mode: z.enum(["persistent", "non-persistent"]).optional(),
    })
    .optional(),

  // MFA settings
  enable_client_connections: z.boolean().optional(),

  // Universal Login settings
  default_redirection_uri: z.string().optional(),

  // Advanced settings
  enabled_locales: z.array(z.string()).optional(),
  default_directory: z.string().optional(),
  error_page: z
    .object({
      html: z.string().optional(),
      show_log_link: z.boolean().optional(),
      url: z.string().optional(),
    })
    .optional(),

  // Flags
  flags: z
    .object({
      allow_legacy_delegation_grant_types: z.boolean().optional(),
      allow_legacy_ro_grant_types: z.boolean().optional(),
      allow_legacy_tokeninfo_endpoint: z.boolean().optional(),
      disable_clickjack_protection_headers: z.boolean().optional(),
      enable_apis_section: z.boolean().optional(),
      enable_client_connections: z.boolean().optional(),
      enable_custom_domain_in_emails: z.boolean().optional(),
      enable_dynamic_client_registration: z.boolean().optional(),
      enable_idtoken_api2: z.boolean().optional(),
      enable_legacy_logs_search_v2: z.boolean().optional(),
      enable_legacy_profile: z.boolean().optional(),
      enable_pipeline2: z.boolean().optional(),
      enable_public_signup_user_exists_error: z.boolean().optional(),
      use_scope_descriptions_for_consent: z.boolean().optional(),
      disable_management_api_sms_obfuscation: z.boolean().optional(),
      enable_adfs_waad_email_verification: z.boolean().optional(),
      revoke_refresh_token_grant: z.boolean().optional(),
      dashboard_log_streams_next: z.boolean().optional(),
      dashboard_insights_view: z.boolean().optional(),
      disable_fields_map_fix: z.boolean().optional(),
      mfa_show_factor_list_on_enrollment: z.boolean().optional(),
    })
    .optional(),

  // Additional settings
  friendly_name: z.string().optional(),
  picture_url: z.string().optional(),
  support_email: z.string().optional(),
  support_url: z.string().optional(),

  // Sandbox settings
  sandbox_version: z.string().optional(),
  sandbox_versions_available: z.array(z.string()).optional(),

  // Change password settings
  change_password: z
    .object({
      enabled: z.boolean(),
      html: z.string(),
    })
    .optional(),

  // Guardian MFA settings
  guardian_mfa_page: z
    .object({
      enabled: z.boolean(),
      html: z.string(),
    })
    .optional(),

  // Default audience
  default_audience: z.string().optional(),

  // Default directory
  default_organization: z.string().optional(),

  // Session management
  sessions: z
    .object({
      oidc_logout_prompt_enabled: z.boolean().optional(),
    })
    .optional(),

  // Guardian MFA Factors configuration (internal storage, exposed via /guardian API)
  mfa: z
    .object({
      policy: mfaPolicySchema.default("never").optional(),
      // Factor states
      factors: z
        .object({
          sms: z.boolean().default(false),
          otp: z.boolean().default(false),
          email: z.boolean().default(false),
          push_notification: z.boolean().default(false),
          webauthn_roaming: z.boolean().default(false),
          webauthn_platform: z.boolean().default(false),
          recovery_code: z.boolean().default(false),
          duo: z.boolean().default(false),
        })
        .optional(),
      // SMS provider configuration
      sms_provider: z
        .object({
          provider: z
            .enum(["twilio", "vonage", "aws_sns", "phone_message_hook"])
            .optional(),
        })
        .optional(),
      // Twilio-specific configuration
      twilio: z
        .object({
          sid: z.string().optional(),
          auth_token: z.string().optional(),
          from: z.string().optional(),
          messaging_service_sid: z.string().optional(),
        })
        .optional(),
      // Phone message configuration (custom)
      phone_message: z
        .object({
          message: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
