import { isPlainObject } from "@authhero/adapter-interfaces";

/**
 * App-type presets for developer invites (#1776). A preset is expanded into
 * Initial Access Token constraints, so the restrictions hold whether the
 * developer registers through the setup page or calls `POST /oidc/register`
 * with the token directly. No machine-to-machine preset: invites are for
 * interactive apps.
 */
export const APP_PRESETS = ["native", "spa", "regular_web"] as const;
export type AppPreset = (typeof APP_PRESETS)[number];

export function isAppPreset(value: unknown): value is AppPreset {
  return (
    typeof value === "string" && APP_PRESETS.some((preset) => preset === value)
  );
}

/**
 * Constraint keys only an operator may set (on the IAT). They are not RFC 7591
 * metadata, the request schema drops them, and registration reads them from
 * the token's constraints only:
 * - `app_type`: the preset (`native`, `spa`, `regular_web`)
 * - `is_first_party`: whether the app skips the consent screen
 * - `connections`: connection ids the app may use; unset means all
 * - `require_pkce`: PKCE with S256 is required at /authorize
 */
export interface OperatorConstraints {
  app_type?: AppPreset;
  is_first_party?: boolean;
  connections?: string[];
  require_pkce?: boolean;
}

export function readOperatorConstraints(
  constraints: Record<string, unknown> | undefined,
): OperatorConstraints {
  if (!constraints) return {};
  const result: OperatorConstraints = {};
  if (isAppPreset(constraints.app_type)) {
    result.app_type = constraints.app_type;
  }
  if (typeof constraints.is_first_party === "boolean") {
    result.is_first_party = constraints.is_first_party;
  }
  if (
    Array.isArray(constraints.connections) &&
    constraints.connections.every((id): id is string => typeof id === "string")
  ) {
    result.connections = constraints.connections;
  }
  if (constraints.require_pkce === true) {
    result.require_pkce = true;
  }
  return result;
}

/**
 * The constraints a preset pins. Every preset is a code-flow app with refresh
 * tokens and PKCE; native and single-page apps are public clients (no
 * secret), regular web apps use `client_secret_post` (Auth0's default).
 */
export function presetConstraints(preset: AppPreset): Record<string, unknown> {
  return {
    app_type: preset,
    application_type: preset === "native" ? "native" : "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method:
      preset === "regular_web" ? "client_secret_post" : "none",
    require_pkce: true,
  };
}

/** Which preset (if any) a registered client was created from. */
export function clientPreset(
  registrationMetadata: Record<string, unknown> | undefined,
): AppPreset | undefined {
  if (!registrationMetadata) return undefined;
  const constraints = registrationMetadata.iat_constraints;
  if (isPlainObject(constraints) && isAppPreset(constraints.app_type)) {
    return constraints.app_type;
  }
  return undefined;
}
