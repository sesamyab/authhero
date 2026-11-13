import {
  decodeBase64UrlString,
  encodeBase64Url,
  encodeHex,
} from "@authhero/adapter-interfaces";

/**
 * The wire-level pieces of a session_transfer_token (#1710, Auth0 "Native to
 * Web SSO"). Everything here is pure: no request context and no data adapters,
 * so the logging helper can import it without a cycle.
 */

/** `issued_token_type` of the exchange response. */
export const SESSION_TRANSFER_TOKEN_TYPE =
  "urn:auth0:params:oauth:token-type:session_transfer_token";

/** Query parameter that carries the token to /authorize. */
export const SESSION_TRANSFER_TOKEN_PARAM = "session_transfer_token";

/** Cookie that carries the token to /authorize. */
export const SESSION_TRANSFER_COOKIE_NAME = "auth0_session_transfer_token";

/** A token is valid for one minute and works once. */
export const SESSION_TRANSFER_TOKEN_TTL_SECONDS = 60;

/** `codes.code_type` of the stored token. */
export const SESSION_TRANSFER_CODE_TYPE = "session_transfer_token";

/**
 * Header in which an authenticated confidential client with
 * `session_transfer.trust_forwarded_ip` passes the end user's IP address.
 */
export const SESSION_TRANSFER_FORWARDED_IP_HEADER = "auth0-forwarded-for";

const TOKEN_BYTES = 32;

/**
 * A refresh-token exchange asks for a session_transfer_token by naming the
 * audience `urn:{tenantDomain}:session_transfer`. The domain is not compared:
 * the token is tenant-scoped and a tenant can be reached on several domains.
 */
export function isSessionTransferAudience(
  audience: string | undefined,
): audience is string {
  return (
    !!audience &&
    audience.startsWith("urn:") &&
    audience.endsWith(":session_transfer") &&
    audience.length > "urn::session_transfer".length
  );
}

/** A fresh opaque token: 256 bits from the CSPRNG, base64url. */
export function generateSessionTransferToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Only the SHA-256 of a token is stored, as the `code_id` it is looked up by,
 * so a database read does not yield usable tokens.
 */
export async function hashSessionTransferToken(token: string): Promise<string> {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

/** Query parameter that carries a Request Object (RFC 9101) to /authorize. */
const REQUEST_OBJECT_PARAM = "request";

const REDACTED = "[REDACTED]";

/**
 * True when `value` is a compact JWT whose payload has a
 * session_transfer_token claim. A signed Request Object is the other place the
 * token travels in an /authorize URL, and its payload is only base64url: who
 * reads the URL reads the token. An encrypted object (JWE) has no readable
 * payload and is left alone.
 */
function requestObjectCarriesToken(value: string): boolean {
  const payloadSegment = value.split(".")[1];
  if (!payloadSegment) return false;
  try {
    const payload: unknown = JSON.parse(decodeBase64UrlString(payloadSegment));
    return (
      typeof payload === "object" &&
      payload !== null &&
      SESSION_TRANSFER_TOKEN_PARAM in payload
    );
  } catch {
    return false;
  }
}

/**
 * Remove the session_transfer_token from a URL before it is stored or handed
 * to a hook, log or log stream: the parameter itself, and a `request`
 * parameter whose Request Object carries the token. The token is a bearer
 * credential for a session; a URL that never contained it is returned
 * untouched.
 */
export function stripSessionTransferToken(url: string): string;
export function stripSessionTransferToken(
  url: string | undefined,
): string | undefined;
export function stripSessionTransferToken(
  url: string | undefined,
): string | undefined {
  // A percent-encoded name ("session%5Ftransfer%5Ftoken") is the same
  // parameter to every query parser, so only a URL that can hold no spelling
  // of either parameter is skipped without parsing.
  if (
    !url ||
    (!url.includes(SESSION_TRANSFER_TOKEN_PARAM) &&
      !url.includes(REQUEST_OBJECT_PARAM) &&
      !url.includes("%"))
  ) {
    return url;
  }

  try {
    const parsed = new URL(url);
    const hasToken = parsed.searchParams.has(SESSION_TRANSFER_TOKEN_PARAM);
    const hasCarrier = parsed.searchParams
      .getAll(REQUEST_OBJECT_PARAM)
      .some(requestObjectCarriesToken);
    if (!hasToken && !hasCarrier) return url;
    parsed.searchParams.delete(SESSION_TRANSFER_TOKEN_PARAM);
    if (hasCarrier) parsed.searchParams.delete(REQUEST_OBJECT_PARAM);
    return parsed.toString();
  } catch {
    // Relative or otherwise unparsable: drop the parameters textually.
    return stripFromRawQuery(url);
  }
}

function stripFromRawQuery(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return url;

  const pairs = beforeHash.slice(queryAt + 1).split("&");
  const kept = pairs.filter((pair) => !pairCarriesToken(pair));
  if (kept.length === pairs.length) return url;

  const query = kept.length > 0 ? `?${kept.join("&")}` : "";
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  return `${beforeHash.slice(0, queryAt)}${query}${hash}`;
}

function pairCarriesToken(pair: string): boolean {
  const equalsAt = pair.indexOf("=");
  const name = decodeQueryPart(
    equalsAt === -1 ? pair : pair.slice(0, equalsAt),
  );
  if (name === SESSION_TRANSFER_TOKEN_PARAM) return true;
  return (
    name === REQUEST_OBJECT_PARAM &&
    equalsAt !== -1 &&
    requestObjectCarriesToken(decodeQueryPart(pair.slice(equalsAt + 1)))
  );
}

function decodeQueryPart(part: string): string {
  const spaced = part.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Replace the token in a parsed query-string record (as logged with a request)
 * with a placeholder: the parameter itself, and a `request` parameter whose
 * Request Object carries the token. Returns the input when neither is there.
 */
export function redactSessionTransferQuery<T>(
  query: Record<string, T>,
): Record<string, T | string> {
  const hasToken = SESSION_TRANSFER_TOKEN_PARAM in query;
  const hasCarrier = queryValueCarriesToken(query[REQUEST_OBJECT_PARAM]);
  if (!hasToken && !hasCarrier) return query;

  const redacted: Record<string, T | string> = { ...query };
  if (hasToken) redacted[SESSION_TRANSFER_TOKEN_PARAM] = REDACTED;
  if (hasCarrier) redacted[REQUEST_OBJECT_PARAM] = REDACTED;
  return redacted;
}

// A logged query value is one string, several joined with a comma, or a list.
function queryValueCarriesToken(value: unknown): boolean {
  if (typeof value === "string") {
    return value.split(",").some(requestObjectCarriesToken);
  }
  return Array.isArray(value) && value.some(queryValueCarriesToken);
}

/**
 * Canonical text form of an IP address, or undefined when the value is not
 * one. Device binding compares canonical forms so the same address spelled two
 * ways (`::FFFF:192.0.2.1` and `192.0.2.1`, upper and lower case hex, zero
 * compression) still matches, and so a forwarded header cannot smuggle
 * anything that is not an address into the stored record.
 */
export function normalizeIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 45) return undefined;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
    const octets = candidate.split(".").map(Number);
    return octets.every((octet) => octet <= 255) ? octets.join(".") : undefined;
  }

  if (!candidate.includes(":") || /[^0-9a-fA-F:.]/.test(candidate)) {
    return undefined;
  }

  let canonical: string;
  try {
    canonical = new URL(`http://[${candidate}]/`).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
  } catch {
    return undefined;
  }

  // IPv4-mapped IPv6 is the same host as the IPv4 address it wraps.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped?.[1] && mapped[2]) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }

  return canonical;
}
