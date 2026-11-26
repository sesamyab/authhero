import { GrantType } from "@authhero/adapter-interfaces";

/**
 * The grant type a response type needs that the client's `grant_types` lacks,
 * or undefined. A `code` response needs `authorization_code`; a response that
 * returns `token` or `id_token` from the authorization endpoint needs
 * `implicit`, so hybrid responses need both. A client without `grant_types`
 * is unrestricted, as at the token endpoint.
 */
export function missingGrantTypeForResponseType(
  grantTypes: string[] | undefined,
  responseType: string | undefined,
): string | undefined {
  if (!grantTypes || grantTypes.length === 0 || !responseType) {
    return undefined;
  }
  const parts = responseType.split(/\s+/).filter(Boolean);
  if (
    parts.includes("code") &&
    !grantTypes.includes(GrantType.AuthorizationCode)
  ) {
    return GrantType.AuthorizationCode;
  }
  if (
    (parts.includes("token") || parts.includes("id_token")) &&
    !grantTypes.includes("implicit")
  ) {
    return "implicit";
  }
  return undefined;
}
