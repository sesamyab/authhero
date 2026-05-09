import { env } from "./env";

export const PLAN_NAME = "oidcc-basic-certification-test-plan";

export const PLAN_VARIANT = {
  server_metadata: "discovery",
  client_registration: "static_client",
} as const;

export const LOGOUT_PLAN_NAME =
  "oidcc-rp-initiated-logout-certification-test-plan";

export const LOGOUT_PLAN_VARIANT = {
  client_registration: "static_client",
  response_type: "code",
} as const;

export const CONFIG_PLAN_NAME = "oidcc-config-certification-test-plan";

export const FORM_POST_BASIC_PLAN_NAME =
  "oidcc-formpost-basic-certification-test-plan";

// Same shape as the basic plan — the form-post profile is encoded in the
// plan name itself, not a variant. server_metadata + client_registration
// stay aligned with the rest of the runner's configs.
export const FORM_POST_BASIC_PLAN_VARIANT = {
  server_metadata: "discovery",
  client_registration: "static_client",
} as const;

export const IMPLICIT_PLAN_NAME = "oidcc-implicit-certification-test-plan";

// The implicit plan pins `response_type` per-module internally (each module
// runs against a fixed response_type — `id_token` or `id_token token` — set
// at module-registration time inside the suite). Passing `response_type` as
// a plan-level variant trips the suite's "Variant 'X' has been set by user,
// but test plan already sets this variant for module ..." 500. Same gotcha
// the config plan documents above. So: server_metadata + client_registration
// only, and let the plan choose the response_type.
export const IMPLICIT_PLAN_VARIANT = {
  server_metadata: "discovery",
  client_registration: "static_client",
} as const;

// The config plan's only module (oidcc-discovery-endpoint-verification)
// already pins server_metadata=discovery + client_registration=static_client
// at the module level, so passing them again as plan-level variants makes
// the suite reject the plan with "Variant 'X' has been set by user, but
// test plan already sets this variant for module ...". Hence: no variants.

function buildSharedClientConfig(label: string) {
  const issuer = env.authheroIssuer.endsWith("/")
    ? env.authheroIssuer
    : `${env.authheroIssuer}/`;
  return {
    alias: env.alias,
    description: `AuthHero local ${label} — ${env.alias}`,
    server: {
      discoveryUrl: `${issuer}.well-known/openid-configuration`,
    },
    // Secrets MUST be ≥32 bytes — the conformance suite derives an HS256 key
    // from client_secret for some negative tests (e.g. bad-id-token-hint
    // signature handling) and refuses to run when the secret is shorter.
    client: {
      client_id: "test-client-id",
      client_secret: "test-client-secret-at-least-32-bytes-long",
    },
    client2: {
      client_id: "test-client-id-2",
      client_secret: "test-client-secret-2-at-least-32-bytes-long",
    },
    // oidcc-server-client-secret-post copies this slot into `client` at
    // configureClient() time (see OIDCCServerTestClientSecretPost.java). The
    // suite assumes servers restrict each client to one auth method, so it
    // wants a separate client config per auth type — we use client-2.
    client_secret_post: {
      client_id: "test-client-id-2",
      client_secret: "test-client-secret-2-at-least-32-bytes-long",
    },
    consent: {},
    browser: [],
  };
}

export function buildPlanConfig() {
  return buildSharedClientConfig("OIDC Basic");
}

export function buildLogoutPlanConfig() {
  return buildSharedClientConfig("OIDC RP-Initiated Logout");
}

export function buildConfigPlanConfig() {
  return buildSharedClientConfig("OIDC Config");
}

export function buildFormPostBasicPlanConfig() {
  return buildSharedClientConfig("OIDC Form Post Basic");
}

export function buildImplicitPlanConfig() {
  return buildSharedClientConfig("OIDC Implicit");
}
