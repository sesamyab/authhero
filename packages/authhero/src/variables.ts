import { Bindings } from "./types";

export function getIssuer(env: Bindings, customDomain?: string) {
  if (customDomain) {
    return `https://${customDomain}/`;
  }
  return env.ISSUER;
}

export function getUniversalLoginUrl(
  env: Bindings,
  customDomain?: string,
  routePrefix: string = "u2",
) {
  // Accept "/u2", "u2/" etc. and normalize to a bare path segment.
  const prefix = routePrefix.replace(/^\/+|\/+$/g, "") || "u2";
  if (customDomain) {
    return `https://${customDomain}/${prefix}/`;
  }
  if (env.UNIVERSAL_LOGIN_URL) {
    // Treat the configured value as a base and inject the route prefix so
    // callers passing a routePrefix (e.g. "u2") target the right base instead
    // of the legacy path baked into UNIVERSAL_LOGIN_URL.
    const base = new URL(env.UNIVERSAL_LOGIN_URL);
    return `${base.origin}/${prefix}/`;
  }
  return `${env.ISSUER}${prefix}/`;
}

/**
 * Redirect targets on the auth server itself that every client may use
 * without registering them: the /u/info and /u2/info test screens.
 *
 * These are exact URLs on purpose. A wildcard over the auth server's own host
 * would make every endpoint on it a valid `redirect_uri` for every client,
 * including the ones that redirect onward.
 */
export function getSelfCallbacks(env: Bindings, customDomain?: string) {
  return [
    `${getUniversalLoginUrl(env, customDomain, "u")}info`,
    `${getUniversalLoginUrl(env, customDomain, "u2")}info`,
  ];
}

export function getAuthUrl(env: Bindings, customDomain?: string) {
  if (customDomain) {
    return `https://${customDomain}/`;
  }
  return env.OAUTH_API_URL || env.ISSUER;
}
