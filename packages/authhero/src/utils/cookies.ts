import { parse, serialize } from "cookie";
import {
  LAST_USED_CONNECTION_COOKIE_NAME,
  LAST_USED_CONNECTION_MAX_AGE_IN_SECONDS,
  SILENT_AUTH_MAX_AGE_IN_SECONDS,
  SILENT_COOKIE_NAME,
} from "../constants";

function getCookieName(tenant_id: string) {
  return `${tenant_id}-${SILENT_COOKIE_NAME}`;
}

function getLastUsedConnectionCookieName(tenant_id: string) {
  return `${tenant_id}-${LAST_USED_CONNECTION_COOKIE_NAME}`;
}

/**
 * Detect dev-mode hostnames where Secure cookies should be skipped.
 *
 * Browsers reject `Secure` cookies over plain HTTP, and `SameSite=None`
 * requires `Secure`, so on `localhost` / `host.docker.internal` / loopback IPs
 * we degrade to `Secure=false` + `SameSite=Lax`. Without this, the OIDC
 * conformance suite (which talks to AuthHero over `http://host.docker.internal:3000`)
 * cannot persist a session cookie between the two `/authorize` calls in
 * `oidcc-prompt-none-logged-in`.
 */
function isInsecureDevHost(host: string | undefined): boolean {
  if (!host) return false;
  // Handle IPv6 in brackets like [::1]:8080; otherwise strip the port.
  let hostname: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    hostname = host.slice(1, end);
  } else {
    hostname = host.split(":")[0] ?? "";
  }
  if (!hostname) return false;
  return (
    hostname === "localhost" ||
    hostname === "host.docker.internal" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function getWildcardDomain(host: string) {
  // Return undefined for empty hostnames
  if (!host) {
    return undefined;
  }
  const [hostname] = host.split(":"); // Remove port if present
  if (!hostname) {
    return undefined;
  }

  // Don't apply wildcards to IP addresses or localhost
  if (hostname === "localhost" || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return undefined;
  }

  // Split the domain into parts
  const parts = hostname.split(".");

  // If the domain is a typical structure (like 'subdomain.domain.com')
  // Ensure it has at least two parts (subdomain  domain)
  if (parts.length > 2) {
    // Join the last two parts to get the main domain
    return `.${parts.slice(-2).join(".")}`; // For example, '.sesamy.com'
  }

  // For a case like 'domain.com' without subdomains
  return `.${hostname}`; // Just return the domain itself (e.g., '.sesamy.com')
}

/**
 * Get all values for a specific cookie name.
 * The `cookie` package's parse() only returns the first value for duplicate cookies.
 * This function returns all values to handle scenarios where users may have multiple
 * cookies with the same name due to:
 * - Domain conflicts (e.g., `.example.com` vs `auth.example.com`)
 * - Path conflicts
 * - Partitioned vs non-partitioned cookies (CHIPS)
 * - Browser quirks in cookie ordering
 */
export function getAllAuthCookies(
  tenant_id: string,
  cookieHeaders?: string,
): string[] {
  if (!cookieHeaders) {
    return [];
  }

  const cookieName = getCookieName(tenant_id);
  const values: string[] = [];

  // Parse cookie header manually to get all values for duplicate cookie names
  // Cookie header format: "name1=value1; name2=value2; name1=value3"
  const pairs = cookieHeaders.split(";");
  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split("=");
    if (name === cookieName && valueParts.length > 0) {
      // Rejoin with '=' in case the value contained '='
      values.push(valueParts.join("="));
    }
  }

  return values;
}

export function getAuthCookie(
  tenant_id: string,
  cookieHeaders?: string,
): string | undefined {
  if (!cookieHeaders) {
    return undefined;
  }
  const cookies = parse(cookieHeaders);
  return cookies[getCookieName(tenant_id)];
}

/**
 * Clears both the non-partitioned and the partitioned session cookie (see
 * serializeAuthCookie). Returns an array of Set-Cookie headers.
 */
export function clearAuthCookie(tenant_id: string, hostname?: string) {
  const cookieName = getCookieName(tenant_id);
  const insecure = isInsecureDevHost(hostname);
  const baseOptions = {
    path: "/",
    httpOnly: true,
    secure: !insecure,
    maxAge: 0,
    sameSite: (insecure ? "lax" : "none") as "lax" | "none",
    domain: hostname ? getWildcardDomain(hostname) : undefined,
  };

  // Clear the non-partitioned cookie, then the partitioned one (skip the
  // partitioned variant on insecure hosts where it would be rejected).
  if (insecure) {
    return [serialize(cookieName, "", baseOptions)];
  }
  return [
    serialize(cookieName, "", baseOptions),
    serialize(cookieName, "", { ...baseOptions, partitioned: true }),
  ];
}

/**
 * Sets the session cookie twice, with the same name and value: once
 * non-partitioned and once partitioned (CHIPS). Browsers store them as two
 * separate cookies. Returns an array of Set-Cookie headers.
 *
 * - The non-partitioned cookie covers top-level navigations to /authorize
 *   (redirect login, cross-site links/302s into login) and same-site iframes.
 *   Some Safari configurations do not send a partitioned cookie on a
 *   top-level /authorize reached through a cross-site redirect (issue #1639).
 * - The partitioned cookie covers logins and silent auth inside a cross-site
 *   iframe (u2 embed mode) once third-party cookies are blocked, where the
 *   non-partitioned cookie is rejected.
 *
 * Both are SameSite=None so the session also reaches cross-site POSTs to the
 * login domain (SAML HTTP-POST binding, POST /authorize). Readers must try
 * every value (getAllAuthCookies), since the two jars can hold different
 * sessions. See apps/docs/architecture/session-cookies.md.
 */
export function serializeAuthCookie(
  tenant_id: string,
  value: string,
  hostname?: string,
) {
  const cookieName = getCookieName(tenant_id);
  const insecure = isInsecureDevHost(hostname);
  const baseOptions = {
    path: "/",
    httpOnly: true,
    secure: !insecure,
    sameSite: (insecure ? "lax" : "none") as "lax" | "none",
    domain: hostname ? getWildcardDomain(hostname) : undefined,
  };

  const cookieOptions = {
    ...baseOptions,
    maxAge: SILENT_AUTH_MAX_AGE_IN_SECONDS,
  };

  // On insecure dev hosts, browsers reject Secure/Partitioned cookies — set
  // a single non-partitioned cookie.
  if (insecure) {
    return [serialize(cookieName, value, cookieOptions)];
  }
  return [
    serialize(cookieName, value, cookieOptions),
    serialize(cookieName, value, { ...cookieOptions, partitioned: true }),
  ];
}

/**
 * Compact snapshot of what the browser sent on an /authorize request, stored
 * on the login session and attached to the resulting login log. A dropped
 * session cookie otherwise leaves no trace: the user just sees the login form.
 * Keep it small — Analytics Engine caps a log's details at 1024 bytes.
 */
export type SessionCookieDiagnostics = {
  /** Number of session-cookie values sent (0, 1, or 2 when both jars are). */
  received: number;
  /** Outcome of looking the values up. */
  result: "none" | "not_found" | "revoked" | "valid" | "sso_disabled";
  /** Total number of cookies in the Cookie header. */
  cookies: number;
  /** Whether the non-partitioned, SameSite=Lax last-used cookie was sent. */
  last_used?: boolean;
  /** Sec-Fetch-Site / Sec-Fetch-Dest / Sec-Fetch-Storage-Access, if sent. */
  fetch_site?: string;
  fetch_dest?: string;
  storage_access?: string;
  /** Host of the Referer, never the full URL. */
  referrer?: string;
};

export function getSessionCookieDiagnostics(
  tenant_id: string,
  headers: { header(name: string): string | undefined },
  received: number,
  result: SessionCookieDiagnostics["result"],
): SessionCookieDiagnostics {
  const cookieHeader = headers.header("cookie");
  let referrer: string | undefined;
  const referer = headers.header("referer");
  if (referer) {
    try {
      referrer = new URL(referer).host;
    } catch {
      referrer = undefined;
    }
  }

  return {
    received,
    result,
    cookies: cookieHeader
      ? cookieHeader.split(";").filter((pair) => pair.trim()).length
      : 0,
    last_used: !!getLastUsedConnectionCookie(tenant_id, cookieHeader),
    fetch_site: headers.header("sec-fetch-site"),
    fetch_dest: headers.header("sec-fetch-dest"),
    storage_access: headers.header("sec-fetch-storage-access"),
    referrer,
  };
}

/**
 * Private-browsing result reported by the login page's client script
 * (detectincognitojs). The server can't detect private browsing itself, so
 * the script writes this short-lived, non-HttpOnly cookie on the login host
 * and the login log reads it back. Must match client/incognito-handler.ts.
 */
export const PRIVATE_BROWSING_COOKIE_NAME = "authhero-private-browsing";

export function getPrivateBrowsingCookie(
  cookieHeaders?: string,
): boolean | undefined {
  if (!cookieHeaders) {
    return undefined;
  }
  const value = parse(cookieHeaders)[PRIVATE_BROWSING_COOKIE_NAME];
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

/**
 * "Last used" connection hint (opt-in via promptSettings.show_last_used_connection).
 *
 * Stores only the connection name — no PII, no fingerprint. Read server-side
 * on the identifier/login screens to badge the matching connection button,
 * so it stays `httpOnly`. SameSite=Lax (not None): it is only read on
 * top-level navigations to the login page, never inside the silent-auth
 * iframe, and Lax also lets it survive without `partitioned`.
 */
export function getLastUsedConnectionCookie(
  tenant_id: string,
  cookieHeaders?: string,
): string | undefined {
  if (!cookieHeaders) {
    return undefined;
  }
  const cookies = parse(cookieHeaders);
  return cookies[getLastUsedConnectionCookieName(tenant_id)];
}

export function serializeLastUsedConnectionCookie(
  tenant_id: string,
  connectionName: string,
  hostname?: string,
): string {
  const insecure = isInsecureDevHost(hostname);
  return serialize(getLastUsedConnectionCookieName(tenant_id), connectionName, {
    path: "/",
    httpOnly: true,
    secure: !insecure,
    sameSite: "lax",
    maxAge: LAST_USED_CONNECTION_MAX_AGE_IN_SECONDS,
    domain: hostname ? getWildcardDomain(hostname) : undefined,
  });
}
