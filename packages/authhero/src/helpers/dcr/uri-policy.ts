import type { AppPreset } from "./presets";

/**
 * URL rules for apps registered or edited by an outside developer (#1776):
 * invite-created apps and apps edited through an edit link.
 *
 * - Every URL: no wildcards, no fragment, no userinfo, at most 1024
 *   characters; at most 20 entries per list.
 * - https is always allowed. http only on a loopback host (`localhost`,
 *   `127.0.0.1`, `[::1]`), any port, for local development (RFC 8252 §7.3).
 * - Native apps may also use a private-use URI scheme containing a dot, e.g.
 *   `com.example.app:/callback` (RFC 8252 §7.1).
 * - Web origins are bare origins (no path, query or fragment) and only for
 *   browser apps.
 *
 * Values already stored on the client are accepted as they are, so an edit
 * link on an older, hand-made client can still save without first fixing
 * every existing URL. New values must follow the rules.
 */

export const MAX_URIS = 20;
export const MAX_URI_LENGTH = 1024;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "about:",
  "blob:",
]);

export type UriField =
  | "redirect_uris"
  | "post_logout_redirect_uris"
  | "web_origins";

export interface UriViolation {
  field: UriField;
  value?: string;
  reason: UriViolationReason;
}

export type UriViolationReason =
  | "too_many"
  | "too_long"
  | "invalid"
  | "wildcard"
  | "fragment"
  | "userinfo"
  | "http_not_loopback"
  | "scheme_not_allowed"
  | "custom_scheme_needs_dot"
  | "origin_only"
  | "not_for_native";

function checkUrl(
  raw: string,
  appType: AppPreset,
  field: UriField,
): UriViolationReason | null {
  if (raw.length > MAX_URI_LENGTH) return "too_long";
  if (raw.includes("*")) return "wildcard";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid";
  }
  if (url.hash || raw.includes("#")) return "fragment";
  if (url.username || url.password) return "userinfo";
  const scheme = url.protocol;
  if (FORBIDDEN_SCHEMES.has(scheme)) return "scheme_not_allowed";

  if (scheme === "https:") {
    if (!url.hostname) return "invalid";
  } else if (scheme === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return "http_not_loopback";
  } else {
    // Private-use URI scheme: native apps only, and never for web origins.
    if (appType !== "native" || field === "web_origins") {
      return "scheme_not_allowed";
    }
    if (!scheme.slice(0, -1).includes(".")) return "custom_scheme_needs_dot";
  }

  if (field === "web_origins") {
    if ((url.pathname && url.pathname !== "/") || url.search) {
      return "origin_only";
    }
  }
  return null;
}

/**
 * Returns the first violation in `values`, or null. `existing` are the values
 * already stored on the client for this field; those are not re-checked.
 */
export function checkUris(
  field: UriField,
  values: string[] | undefined,
  appType: AppPreset,
  existing: string[] = [],
): UriViolation | null {
  if (!values || values.length === 0) return null;
  if (field === "web_origins" && appType === "native") {
    return { field, reason: "not_for_native" };
  }
  if (values.length > MAX_URIS) return { field, reason: "too_many" };
  const grandfathered = new Set(existing);
  for (const value of values) {
    if (grandfathered.has(value)) continue;
    const reason = checkUrl(value, appType, field);
    if (reason) return { field, value, reason };
  }
  return null;
}

const REASON_TEXT: Record<UriViolationReason, string> = {
  too_many: `at most ${MAX_URIS} entries are allowed`,
  too_long: `URLs may be at most ${MAX_URI_LENGTH} characters`,
  invalid: "is not a valid URL",
  wildcard: "wildcards are not allowed",
  fragment: "fragments (#) are not allowed",
  userinfo: "user names and passwords in URLs are not allowed",
  http_not_loopback:
    "http is only allowed for localhost, 127.0.0.1 or [::1]; use https",
  scheme_not_allowed: "this URL scheme is not allowed for this app type",
  custom_scheme_needs_dot:
    "custom URL schemes must contain a dot, for example com.example.app:/callback",
  origin_only:
    "must be an origin without a path, for example https://app.example.com",
  not_for_native: "native apps do not use web origins",
};

export function describeUriViolation(violation: UriViolation): string {
  const subject = violation.value
    ? `${violation.field}: "${violation.value}"`
    : violation.field;
  return `${subject} ${REASON_TEXT[violation.reason]}`;
}
