/**
 * The tenant's custom font (`branding.font.url` / `theme.fonts.font_url`).
 *
 * As in Auth0, the URL normally points at a font *file* (`.woff2`, `.woff`,
 * `.ttf`, `.otf`). It used to be emitted as `<link rel="stylesheet">`, which
 * the browser fetches and then discards, because a font file is not CSS, so
 * the font never applied. A font file is now declared with an `@font-face`
 * for the `ulp-font` family, which the widget stylesheet already lists first.
 * Any other URL is still treated as a stylesheet (e.g. a Google Fonts CSS
 * URL), which is expected to define `ulp-font` itself.
 */
import { escapeHtml, sanitizeCssUrl, sanitizeUrl } from "./html";

/** Family name the custom font is registered under (Auth0's convention). */
export const CUSTOM_FONT_FAMILY = "ulp-font";

/**
 * `font-family` for page chrome when a custom font is configured. "Inter"
 * stays as a fallback for tenants whose font URL is a stylesheet that only
 * defines Inter, which is what the chrome used to hard-code.
 */
export const CUSTOM_FONT_STACK = `"${CUSTOM_FONT_FAMILY}", "Inter", system-ui, -apple-system, sans-serif`;

/**
 * The effective custom-font URL: `theme.fonts.font_url` wins over
 * `branding.font.url`. The widget and every server-rendered page resolve it
 * here, so the page chrome and the widget never load different fonts.
 */
export function resolveCustomFontUrl(
  theme: { fonts?: { font_url?: string } } | null | undefined,
  branding: { font?: { url?: string } } | null | undefined,
): string | undefined {
  return theme?.fonts?.font_url || branding?.font?.url || undefined;
}

const FORMAT_BY_EXTENSION: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/**
 * The CSS `format()` hint for a font-file URL, or undefined when the URL
 * does not look like a font file (and should be loaded as a stylesheet).
 * Decided by the path's extension, ignoring query and hash, or by the media
 * type of a `data:font/...` URL.
 */
export function fontFileFormat(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const dataMatch = /^data:font\/([a-z0-9-]+)[;,]/i.exec(url);
  if (dataMatch) {
    const subtype = dataMatch[1]?.toLowerCase();
    return subtype ? FORMAT_BY_EXTENSION[subtype] : undefined;
  }
  let pathname: string;
  try {
    pathname = new URL(url, "https://base.invalid").pathname;
  } catch {
    return undefined;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension ? FORMAT_BY_EXTENSION[extension] : undefined;
}

/**
 * `@font-face` rule registering a font-file URL as `ulp-font`, or "" when the
 * URL is not a font file or is unsafe. Safe to place inside a `<style>`.
 */
export function buildFontFaceCss(url: string | undefined): string {
  const format = fontFileFormat(url);
  if (!format) return "";
  const safeUrl = sanitizeCssUrl(url);
  if (!safeUrl) return "";
  return `@font-face { font-family: "${CUSTOM_FONT_FAMILY}"; src: url("${safeUrl}") format("${format}"); font-display: swap; }`;
}

/**
 * How a page loads the custom font: an inline `@font-face` for a font file,
 * a stylesheet `href` (HTML-escaped) for anything else, or nothing.
 */
export type FontHead =
  | { kind: "font-face"; css: string }
  | { kind: "stylesheet"; href: string }
  | undefined;

export function resolveFontHead(url: string | undefined): FontHead {
  if (!url) return undefined;
  if (fontFileFormat(url)) {
    const css = buildFontFaceCss(url);
    return css ? { kind: "font-face", css } : undefined;
  }
  const href = sanitizeUrl(url);
  return href ? { kind: "stylesheet", href } : undefined;
}

/**
 * The custom font as `<head>` markup. Tagged `data-authhero-font` with the
 * raw URL so the widget recognises it and doesn't inject a second copy.
 */
export function renderFontHead(url: string | undefined): string {
  const head = resolveFontHead(url);
  if (!head || !url) return "";
  const marker = `data-authhero-font="${escapeHtml(url)}"`;
  return head.kind === "font-face"
    ? `<style ${marker}>${head.css}</style>`
    : `<link rel="stylesheet" href="${head.href}" ${marker}>`;
}
