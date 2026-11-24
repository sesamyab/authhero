import type { Branding } from "@authhero/adapter-interfaces";
import { sanitizeUrl } from "./sanitization-utils";

export interface LegalUrls {
  /** Terms-of-service link (or the legacy combined "terms" link). */
  termsAndConditionsUrl?: string;
  privacyUrl?: string;
}

/**
 * The terms and privacy URLs for a client, from its `client_metadata`:
 * `tos_uri` / `policy_uri` (the DCR names), with the older single
 * `termsAndConditionsUrl` kept as the terms fallback so existing clients
 * render as before. Each value is sanitised and omitted when empty.
 */
export function clientLegalUrls(
  metadata: Record<string, string | undefined> | undefined,
): LegalUrls {
  return {
    termsAndConditionsUrl:
      sanitizeUrl(metadata?.tos_uri) ||
      sanitizeUrl(metadata?.termsAndConditionsUrl) ||
      undefined,
    privacyUrl: sanitizeUrl(metadata?.policy_uri) || undefined,
  };
}

/**
 * Fill whatever the client left unset from the tenant's branding defaults
 * (`terms_url`, `privacy_url`). A client value always wins.
 */
export function withTenantLegalDefaults(
  legal: LegalUrls,
  branding: Pick<Branding, "terms_url" | "privacy_url"> | null | undefined,
): LegalUrls {
  return {
    termsAndConditionsUrl:
      legal.termsAndConditionsUrl ||
      sanitizeUrl(branding?.terms_url) ||
      undefined,
    privacyUrl:
      legal.privacyUrl || sanitizeUrl(branding?.privacy_url) || undefined,
  };
}
