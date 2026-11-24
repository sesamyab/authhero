import {
  authorizedHttpClient,
  createOrganizationHttpClient,
  isSingleTenantForDomain,
} from "@/authProvider";
import {
  buildUrlWithProtocol,
  formatDomain,
  getDomainFromStorage,
  getSelectedDomainFromStorage,
} from "@/utils/domainUtils";
import { getConfigValue } from "@/utils/runtimeConfig";

/** Resolve the REST API base URL for the currently selected domain. */
export function getApiUrl(): string {
  const domains = getDomainFromStorage();
  const selectedDomain = getSelectedDomainFromStorage();
  const formattedSelectedDomain = formatDomain(selectedDomain);
  const domainConfig = domains.find(
    (d) => formatDomain(d.url) === formattedSelectedDomain,
  );

  let apiUrl: string;
  if (domainConfig?.restApiUrl) {
    apiUrl = buildUrlWithProtocol(domainConfig.restApiUrl);
  } else if (selectedDomain) {
    apiUrl = buildUrlWithProtocol(selectedDomain);
  } else {
    apiUrl = buildUrlWithProtocol(getConfigValue("apiUrl"));
  }

  return apiUrl.replace(/\/$/, "");
}

/** Pick the right authorized HTTP client for the selected domain/tenant. */
export function getHttpClient(tenantId: string) {
  const formattedDomain = formatDomain(getSelectedDomainFromStorage());
  if (isSingleTenantForDomain(formattedDomain)) {
    return authorizedHttpClient;
  }
  return createOrganizationHttpClient(tenantId);
}

/** Sample screens the server can render for the branding preview. */
export const PREVIEW_SCREENS = [
  "login",
  "password",
  "signup",
  "otp",
  "mfa",
  "consent",
  "error",
] as const;

export type PreviewScreenId = (typeof PREVIEW_SCREENS)[number];

/** The scheme the preview is rendered in. */
export type PreviewColorScheme = "light" | "dark";

interface PreviewRequest {
  tenantId: string;
  /** Sample screen to render. */
  screen?: string;
  /** Unsaved template body to preview. Omit to use the stored/default template. */
  body?: string;
  /** Live branding overrides so the preview reflects unsaved form edits. */
  branding?: unknown;
  /** Live theme overrides so the preview reflects unsaved form edits. */
  theme?: unknown;
  /**
   * Render in this scheme. The server applies its own dark fallback chain
   * (explicit dark fields, then derived values, then light), so the preview
   * cannot disagree with the real login page.
   */
  colorScheme?: PreviewColorScheme;
  signal?: AbortSignal;
}

type OpenFullPreviewOptions = Omit<PreviewRequest, "signal">;

/**
 * Drop null, undefined and empty-string values (recursively). The preview
 * endpoint validates its overrides, and an emptied form field must not make
 * the whole request fail.
 */
export function pruneEmpty<T>(value: T): T | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length ? (out as T) : undefined;
  }
  return value;
}

/**
 * Render the full Universal Login page through the server's preview endpoint
 * and return its HTML. This is the same renderer the real login uses, so the
 * template, dark scheme, background image and widget build all match.
 */
export async function fetchPreviewHtml({
  tenantId,
  screen,
  body,
  branding,
  theme,
  colorScheme,
  signal,
}: PreviewRequest): Promise<string> {
  const apiUrl = getApiUrl();
  const httpClient = getHttpClient(tenantId);
  const brandingWithScheme = colorScheme
    ? { ...((branding as object | undefined) ?? {}), dark_mode: colorScheme }
    : branding;
  const response = await httpClient(
    `${apiUrl}/api/v2/branding/templates/universal-login/preview`,
    {
      method: "POST",
      headers: new Headers({
        "tenant-id": tenantId,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        screen,
        body,
        branding: brandingWithScheme,
        theme,
      }),
      signal,
    },
  );

  const html =
    response && typeof response === "object" && "body" in response
      ? (response as { body?: string }).body
      : undefined;
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("Empty preview response");
  }
  return html;
}

/**
 * Make server-relative URLs in the rendered page (`/u/widget/...`) resolve
 * against the API origin instead of the admin's, by adding a `<base>`.
 */
export function withApiBase(html: string, apiUrl: string): string {
  const base = `<base href="${apiUrl.replace(/"/g, "&quot;")}/">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${base}`);
  }
  return base + html;
}

/**
 * Open the full-page Universal Login preview in a new browser tab.
 *
 * The preview endpoint requires a Bearer token, so we can't simply point a
 * tab at the URL — instead we fetch the rendered HTML with the authorized
 * client and render it. The tab is opened synchronously on the user gesture to
 * avoid popup blockers, then populated once the HTML arrives.
 *
 * The (tenant-controlled) template HTML is rendered inside a sandboxed iframe
 * without `allow-same-origin`, so it executes in an opaque origin and cannot
 * reach the admin origin's storage, cookies, or APIs.
 */
export async function openFullPreview(
  options: OpenFullPreviewOptions,
): Promise<void> {
  const win = window.open("", "_blank");
  if (!win) {
    throw new Error(
      "Could not open the preview tab. Your browser blocked the popup — please allow popups for this site and try again.",
    );
  }
  win.document.write(
    "<!doctype html><title>Loading preview…</title><body style='font-family:system-ui;padding:24px;color:#555'>Loading preview…</body>",
  );

  try {
    const html = await fetchPreviewHtml(options);

    // Replace the loading shell with a sandboxed iframe holding the template.
    // `srcdoc` is set via the property (no escaping needed) and the sandbox
    // omits `allow-same-origin`, isolating the template in an opaque origin.
    win.document.open();
    win.document.write(
      "<!doctype html><html><head><meta charset='utf-8'><title>Universal Login preview</title>" +
        "<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100vh}</style>" +
        "</head><body></body></html>",
    );
    win.document.close();
    const iframe = win.document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    iframe.srcdoc = html;
    win.document.body.appendChild(iframe);
  } catch (err) {
    win.document.body.innerHTML =
      "<p style='font-family:system-ui;padding:24px;color:#b91c1c'>Failed to load preview.</p>";
    throw err;
  }
}
