import { z } from "@hono/zod-openapi";
import { credentialString } from "../utils/credentials";
import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
} from "./AuthParams";
import { configInheritanceShape } from "./ConfigInheritance";

export const connectionOptionsSchema = z.object({
  kid: z.string().optional(),
  team_id: z.string().optional(),
  realms: z.string().optional(),
  authentication_method: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: credentialString().optional(),
  app_secret: credentialString().optional(),
  scope: z.string().optional(),
  // Response-only masked previews of the secret fields above. The management
  // API strips the secrets themselves and returns a hint (e.g. "3a9f••••••••")
  // so a UI can show that a secret is set without ever exposing it. They are
  // ignored on write — sending one back never persists it.
  client_secret_hint: z.string().optional(),
  app_secret_hint: z.string().optional(),
  twilio_token_hint: z.string().optional(),
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string().optional(),
  userinfo_endpoint: z.string().optional(),
  jwks_uri: z.string().optional(),
  discovery_url: z.string().optional(),
  issuer: z.string().optional(),
  // How client credentials are sent to the token endpoint for upstream OIDC /
  // OAuth2 connections. Defaults to `client_secret_basic` (HTTP Basic auth).
  // Set to `client_secret_post` for providers like JumpCloud that reject Basic.
  token_endpoint_auth_method: z
    .enum(["client_secret_basic", "client_secret_post"])
    .optional(),
  provider: z.string().optional(),
  from: z.string().optional(),
  twilio_sid: credentialString().optional(),
  twilio_token: credentialString().optional(),
  icon_url: z.string().optional(),
  // Email domains that route to this connection via Home Realm Discovery
  domain_aliases: z.array(z.string()).optional(),
  // Per-connection redirect_uri sent to the upstream IdP. When unset, the
  // strategy falls back to the legacy `${authUrl}callback`. Lets operators
  // migrate connections to a new callback path (e.g. `/login/callback`)
  // gradually — the value must be registered as an allowed redirect URI at
  // the upstream IdP.
  callback_url: z.string().url().optional(),
  // Password policy options for Username-Password-Authentication connections
  passwordPolicy: z
    .enum(["none", "low", "fair", "good", "excellent"])
    .optional(),
  password_complexity_options: z
    .object({
      min_length: z.number().optional(),
    })
    .optional(),
  password_history: z
    .object({
      enable: z.boolean().optional(),
      size: z.number().optional(),
    })
    .optional(),
  password_no_personal_info: z
    .object({
      enable: z.boolean().optional(),
    })
    .optional(),
  password_dictionary: z
    .object({
      enable: z.boolean().optional(),
      dictionary: z.array(z.string()).optional(),
    })
    .optional(),
  // Disable signup for this connection
  disable_signup: z.boolean().optional(),
  // Brute force protection
  brute_force_protection: z.boolean().optional(),
  // Import mode (Auth0 custom-DB semantics): when true and a successful
  // upstream verification occurs, the user/password row is created locally
  // so subsequent logins are served entirely from authhero.
  import_mode: z.boolean().optional(),
  // Upstream migration credentials. Mirrors Auth0's
  // `options.configuration` (encrypted env-vars accessed from custom
  // scripts). For lazy migration, set when `import_mode: true`.
  configuration: z
    .object({
      token_endpoint: z.string().optional(),
      userinfo_endpoint: z.string().optional(),
      client_id: z.string().optional(),
      client_secret: credentialString().optional(),
      // Response-only masked preview of `client_secret`, see above.
      client_secret_hint: z.string().optional(),
      // Optional override for the `realm` sent in the password-realm grant.
      // Defaults to the connection name when omitted.
      realm: z.string().optional(),
    })
    .optional(),
  // Flexible Identifiers: attributes schema (replaces legacy requires_username)
  attributes: z
    .object({
      email: z
        .object({
          identifier: z
            .object({
              active: z.boolean().optional(),
            })
            .optional(),
          signup: z
            .object({
              status: z.enum(["required", "optional", "disabled"]).optional(),
              verification: z
                .object({
                  active: z.boolean().optional(),
                })
                .optional(),
            })
            .optional(),
          validation: z
            .object({
              allowed: z.boolean().optional(),
            })
            .optional(),
          unique: z.boolean().optional(),
          profile_required: z.boolean().optional(),
          verification_method: z.enum(["link", "code"]).optional(),
        })
        .optional(),
      username: z
        .object({
          identifier: z
            .object({
              active: z.boolean().optional(),
            })
            .optional(),
          signup: z
            .object({
              status: z.enum(["required", "optional", "disabled"]).optional(),
            })
            .optional(),
          validation: z
            .object({
              max_length: z.number().optional(),
              min_length: z.number().optional(),
              allowed_types: z
                .object({
                  email: z.boolean().optional(),
                  phone_number: z.boolean().optional(),
                })
                .optional(),
            })
            .optional(),
          profile_required: z.boolean().optional(),
        })
        .optional(),
      phone_number: z
        .object({
          identifier: z
            .object({
              active: z.boolean().optional(),
            })
            .optional(),
          signup: z
            .object({
              status: z.enum(["required", "optional", "disabled"]).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  // Authentication methods for Username-Password-Authentication connections
  authentication_methods: z
    .object({
      password: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
      passkey: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  // Passkey options for Username-Password-Authentication connections
  passkey_options: z
    .object({
      challenge_ui: z.enum(["both", "autofill", "button"]).optional(),
      local_enrollment_enabled: z.boolean().optional(),
      progressive_enrollment_enabled: z.boolean().optional(),
    })
    .optional(),
  // Legacy username options (deprecated, use attributes instead)
  requires_username: z.boolean().optional(),
  validation: z
    .object({
      username: z
        .object({
          min: z.number().optional(),
          max: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  // `external` connections only: lets actions create and update users in this
  // connection with `api.users.ensure`. Off by default.
  allow_action_users: z.boolean().optional(),
  // Controls when root user attributes are updated from external IdP
  set_user_root_attributes: z
    .enum(["on_each_login", "on_first_login", "never_on_login"])
    .optional(),
  // SAML (`samlp`) enterprise connections, with Auth0's option names.
  // The IdP's SingleSignOnService URL.
  signInEndpoint: z.string().optional(),
  // The IdP's SingleLogoutService URL.
  signOutEndpoint: z.string().optional(),
  // The IdP signing certificate: PEM, base64 DER, or base64 of the PEM (the
  // form Auth0 documents). Responses must be signed with it.
  signingCert: z.string().optional(),
  // Further trusted IdP certificates, e.g. the incoming one during the IdP's
  // certificate rotation. Filled from metadata when it lists several.
  signingCerts: z.array(z.string()).optional(),
  // IdP metadata; when set on create/update the management API fills
  // signInEndpoint, signOutEndpoint, signingCert(s) and `issuer` from it.
  metadataUrl: z.string().optional(),
  metadataXml: z.string().optional(),
  // Sign AuthnRequests with the tenant's SAML key (HTTP-Redirect binding).
  signSAMLRequest: z.boolean().optional(),
  signatureAlgorithm: z.enum(["rsa-sha256", "rsa-sha1"]).optional(),
  digestAlgorithm: z.enum(["sha256", "sha1"]).optional(),
  // Binding used to send the AuthnRequest: HTTP-Redirect (default) or
  // HTTP-POST. Anything else is rejected rather than silently sent as a
  // redirect to an endpoint that may only accept POST.
  protocolBinding: z
    .enum([
      "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
      "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    ])
    .optional(),
  // SAML attribute holding the user id; defaults to the NameID.
  user_id_attribute: z.string().optional(),
  // Profile field → SAML attribute name(s), overriding the defaults.
  fieldsMap: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
  // SP entity ID (the assertion audience). Defaults to
  // `urn:auth0:{tenant_id}:{connection_name}`, as in Auth0.
  entityId: z.string().optional(),
});

// terraform's auth0 provider serializes unset connection-options fields as
// JSON null, including inside nested objects (e.g. password_complexity_options,
// attributes.email.signup). Strip nulls recursively before validation so
// optional fields don't reject "null" values at any depth.
function stripNullsDeep(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) {
    return v.filter((x) => x !== null).map(stripNullsDeep);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue;
      out[k] = stripNullsDeep(val);
    }
    return out;
  }
  return v;
}

export const connectionInsertSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  display_name: z.string().optional(),
  strategy: z.string(),
  options: z
    .preprocess(
      (v) => (v === null ? {} : stripNullsDeep(v)),
      connectionOptionsSchema,
    )
    .default({}),
  enabled_clients: z.array(z.string()).default([]).optional(),
  response_type: z.nativeEnum(AuthorizationResponseType).optional(),
  response_mode: z.nativeEnum(AuthorizationResponseMode).optional(),
  is_domain_connection: z.boolean().optional(),
  show_as_button: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  is_system: z.boolean().optional(),
  ...configInheritanceShape,
});
export type ConnectionInsert = z.infer<typeof connectionInsertSchema>;

export const connectionSchema = z
  .object({
    id: z.string(),
    created_at: z.string().transform((val) => (val === null ? "" : val)),
    updated_at: z.string().transform((val) => (val === null ? "" : val)),
  })
  .extend(connectionInsertSchema.shape);

/**
 * An email domain claimed by a self-service SSO connection. Only a `verified`
 * domain is trusted: a user of the connection whose email is in it may have
 * `email_verified: true` and take part in email-based account linking.
 */
export const connectionSelfServiceDomainSchema = z.object({
  domain: z.string(),
  status: z.enum(["pending", "verified"]),
  verified_at: z.string().optional(),
});

/**
 * Marks a connection as set up or managed through Self-Service SSO (#1763).
 * Internal state, not part of the Auth0 connection: it is not in
 * `connectionInsertSchema` (so the Management API cannot set it, and
 * import, rollout and config sync do not copy it) nor in `connectionSchema`
 * (so it is not in the API's response schema), and the Management API strips
 * it from every response.
 */
export const connectionSelfServiceSchema = z.object({
  profile_id: z.string().optional(),
  domains: z.array(connectionSelfServiceDomainSchema).default([]),
});

export type ConnectionSelfServiceDomain = z.infer<
  typeof connectionSelfServiceDomainSchema
>;
export type ConnectionSelfService = z.infer<typeof connectionSelfServiceSchema>;

/** Fields adapters store on a connection that are not part of the Auth0 API. */
export type ConnectionInternalFields = {
  /** Set for a self-service SSO connection, `null`/absent otherwise. */
  self_service?: ConnectionSelfService | null;
};

export type Connection = z.infer<typeof connectionSchema> &
  ConnectionInternalFields;
