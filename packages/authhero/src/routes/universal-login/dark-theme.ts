/**
 * Resolves the dark-scheme inputs of the login page from a tenant's theme and
 * branding.
 *
 * Precedence between the two stores: when a theme exists its values win, and
 * `branding` is only the fallback (logo, page background). The widget already
 * worked this way (`theme.widget.logo_url || branding.logo_url`); the page
 * chrome now does too.
 *
 * Fallback order per value in the dark scheme: explicit tenant dark field
 * (`theme.colors_dark`, `widget.logo_url_dark`, `page_background.*_dark`),
 * then the derived dark value, then the light value. All dark fields are an
 * AuthHero extension of the Auth0 theme format and optional.
 */
import { buildThemePageBackground } from "@authhero/widget/page-chrome";
import type { ColorsDark } from "@authhero/widget/page-chrome";
import { sanitizeCssColor, sanitizeUrl } from "./sanitization-utils";

// Values end up inside a <style> block; keep anything that could close a
// declaration or the block out, on top of the generic colour check.
const UNSAFE_CSS_CHARS = /[;{}<>"'\\]/;

function safeColor(value: unknown): string {
  if (typeof value !== "string" || UNSAFE_CSS_CHARS.test(value)) return "";
  return sanitizeCssColor(value);
}

export function sanitizeColorsDark(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colorsDark: any,
): ColorsDark | undefined {
  if (!colorsDark || typeof colorsDark !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(colorsDark)) {
    const safe = safeColor(value);
    if (safe) out[key] = safe;
  }
  return Object.keys(out).length ? (out as ColorsDark) : undefined;
}

export type DarkPageInputs = {
  /** Sanitized explicit dark colour overrides. */
  colorsDark?: ColorsDark;
  /** Light brand link colour, so derived dark keeps it. */
  linkColor?: string;
  /** CSS `background` for the dark scheme; undefined = same as light. */
  darkBackground?: string;
  /** Logo for the light scheme (theme wins over branding). */
  logoUrl: string | null;
  /** Logo for the dark scheme, only when the theme defines one. */
  logoUrlDark: string | null;
  hasDarkLogo: boolean;
  /** Any page background image, light or dark (drives the chip surface). */
  hasBgImage: boolean;
};

export function resolveDarkPageInputs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
  branding: { logo_url?: string } | null | undefined,
  themePageBackground?: {
    background_color?: string;
    background_image_url?: string;
    background_color_dark?: string;
    background_image_url_dark?: string;
  },
): DarkPageInputs {
  const pb = themePageBackground ?? theme?.page_background;
  const logo = theme?.widget?.logo_url || branding?.logo_url;
  const logoUrl = logo ? sanitizeUrl(logo) || null : null;
  const darkLogo = logoUrl ? theme?.widget?.logo_url_dark : undefined;
  const logoUrlDark = darkLogo ? sanitizeUrl(darkLogo) || null : null;

  const darkColor = safeColor(pb?.background_color_dark);
  const darkImage = pb?.background_image_url_dark;
  let darkBackground: string | undefined;
  if (darkColor || darkImage) {
    // Dark colour -> light colour; dark image -> light image. The colour sits
    // under the image, as in the light scheme.
    darkBackground = buildThemePageBackground(
      {
        background_color: darkColor || pb?.background_color,
        background_image_url: darkImage || pb?.background_image_url,
      },
      undefined,
    );
  }

  return {
    colorsDark: sanitizeColorsDark(theme?.colors_dark),
    linkColor: safeColor(theme?.colors?.links_focused_components) || undefined,
    darkBackground,
    logoUrl,
    logoUrlDark,
    hasDarkLogo: !!logoUrlDark,
    hasBgImage: !!(pb?.background_image_url || darkImage),
  };
}
