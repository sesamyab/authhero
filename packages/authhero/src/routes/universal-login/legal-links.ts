import type { Branding } from "@authhero/adapter-interfaces";

export interface LegalUrls {
  /** Terms-of-service link (or the legacy combined "terms" link). */
  termsAndConditionsUrl?: string;
  privacyUrl?: string;
}

/**
 * A URL that can be opened as a legal link: http(s), or a path starting with
 * `/` (accepted before, so legacy links keep working). Anything else
 * (`javascript:`, `data:`, garbage) is rejected so the next source is used
 * instead.
 *
 * The value is returned as-is, NOT HTML-escaped: the page-chrome renderers
 * (`renderLegalChip`, `renderMobileFooter`) escape it once when they write the
 * `href`. Escaping here too would turn `?a=1&b=2` into `&amp;amp;`.
 */
function legalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/")) return url;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The terms and privacy URLs for a client, from its `client_metadata`:
 * `tos_uri` / `policy_uri` (the DCR names), with the older single
 * `termsAndConditionsUrl` kept as the terms fallback so existing clients
 * render as before. Unusable values are omitted.
 */
export function clientLegalUrls(
  metadata: Record<string, string | undefined> | undefined,
): LegalUrls {
  return {
    termsAndConditionsUrl:
      legalUrl(metadata?.tos_uri) ?? legalUrl(metadata?.termsAndConditionsUrl),
    privacyUrl: legalUrl(metadata?.policy_uri),
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
      legal.termsAndConditionsUrl ?? legalUrl(branding?.terms_url),
    privacyUrl: legal.privacyUrl ?? legalUrl(branding?.privacy_url),
  };
}
