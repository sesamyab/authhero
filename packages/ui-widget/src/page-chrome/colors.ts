/**
 * Dark-mode CSS variables and the contrast maths behind them.
 *
 * Pure functions, moved out of the authhero page module so the widget demo
 * renders the same dark mode the real login page does.
 */

export const DARK_MODE_CSS_VARS: Record<string, string> = {
  "--ah-color-text": "#f9fafb",
  "--ah-color-text-muted": "#9ca3af",
  "--ah-color-text-label": "#d1d5db",
  // Header is read by the widget as `--ah-color-text-header` first, falling
  // back to the legacy `--ah-color-header`. Set both so an applied theme's
  // `header` color (e.g. DEFAULT_THEME's #000000) can't leave the title black.
  "--ah-color-text-header": "#f9fafb",
  "--ah-color-header": "#f9fafb",
  "--ah-color-bg": "#1f2937",
  "--ah-color-bg-hover": "#374151",
  "--ah-color-bg-muted": "#374151",
  "--ah-color-bg-disabled": "#4b5563",
  "--ah-color-input-bg": "#374151",
  // Typed input text and secondary-button label are also driven by the theme
  // (input_filled_text / secondary_button_label) and default to #000000, which
  // is unreadable on the dark input/widget surfaces above.
  "--ah-color-input-text": "#f9fafb",
  "--ah-btn-secondary-text": "#f9fafb",
  "--ah-color-border": "#4b5563",
  "--ah-color-border-hover": "#6b7280",
  "--ah-color-border-muted": "#374151",
  "--ah-color-error-bg": "rgba(220,38,38,0.2)",
  "--ah-color-success-bg": "rgba(22,163,74,0.2)",
  "--ah-color-link": "#60a5fa",
};

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Parse a hex color into `[r, g, b]`.
 *
 * Accepts every hex form `sanitizeCssColor` lets through: `#rgb`, `#rgba`,
 * `#rrggbb` and `#rrggbbaa`. Shorthand is expanded before parsing (`#fff` is
 * white, not `[0, 15, 255]`) and any alpha channel is dropped — these values
 * feed luminance and contrast maths, which only read the color channels.
 */
function parseDarkHex(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  const expanded =
    value.length <= 4 ? [...value].map((d) => d + d).join("") : value;
  const n = parseInt(expanded.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function darkLuminance(hex: string): number {
  const [r, g, b] = parseDarkHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function darkContrastRatio(h1: string, h2: string): number {
  const l1 = darkLuminance(h1);
  const l2 = darkLuminance(h2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export function lightenHexDark(hex: string, pct: number): string {
  const [r, g, b] = parseDarkHex(hex);
  const f = (v: number) =>
    Math.min(255, Math.round(v + (255 - v) * pct))
      .toString(16)
      .padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`;
}
/**
 * Explicit dark-scheme colour overrides (`theme.colors_dark`, an AuthHero
 * extension). Every key is optional; same names as `theme.colors`.
 */
export type ColorsDark = Partial<{
  base_focus_color: string;
  base_hover_color: string;
  body_text: string;
  error: string;
  header: string;
  icons: string;
  input_background: string;
  input_border: string;
  input_filled_text: string;
  input_labels_placeholders: string;
  links_focused_components: string;
  primary_button: string;
  primary_button_label: string;
  secondary_button_border: string;
  secondary_button_label: string;
  success: string;
  widget_background: string;
  widget_border: string;
}>;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Lighten a brand colour until it reads on the dark card (contrast >= `min`).
 * Non-hex input is returned as is. Used to keep the brand link colour in dark
 * instead of falling back to the stock blue.
 */
export function ensureDarkContrast(
  color: string,
  bg: string,
  min = 4.5,
): string {
  if (!HEX.test(color) || !HEX.test(bg)) return color;
  if (darkContrastRatio(color, bg) >= min) return color;
  for (let i = 1; i <= 10; i++) {
    const adjusted = lightenHexDark(color, i * 0.1);
    if (darkContrastRatio(adjusted, bg) >= min) return adjusted;
  }
  return "#ffffff";
}

/**
 * Map `colors_dark` to the widget's CSS variables. Mirrors `themeToCssVars`
 * (ui-widget utils/branding.ts) without the light-background contrast fixes:
 * an explicit dark value is taken as written.
 */
export function colorsDarkToCssVars(
  c: ColorsDark | undefined,
): Record<string, string> {
  const v: Record<string, string> = {};
  if (!c) return v;
  const set = (key: string, value: string | undefined) => {
    if (value) v[key] = value;
  };
  set("--ah-color-primary", c.primary_button);
  set("--ah-color-text-on-primary", c.primary_button_label);
  set("--ah-btn-secondary-border", c.secondary_button_border);
  set("--ah-btn-secondary-text", c.secondary_button_label);
  set("--ah-color-text", c.body_text);
  set("--ah-color-text-header", c.header);
  set("--ah-color-header", c.header);
  set("--ah-color-text-label", c.input_labels_placeholders);
  set("--ah-color-text-muted", c.input_labels_placeholders);
  set("--ah-color-input-text", c.input_filled_text);
  set("--ah-color-bg", c.widget_background);
  set("--ah-color-input-bg", c.input_background);
  set("--ah-widget-border-color", c.widget_border);
  set("--ah-color-border", c.input_border);
  set("--ah-color-link", c.links_focused_components);
  set("--ah-color-focus-ring", c.base_focus_color);
  set("--ah-color-primary-hover", c.base_hover_color);
  set("--ah-color-error", c.error);
  set("--ah-color-success", c.success);
  set("--ah-color-icon", c.icons);
  // An explicit dark primary without a label gets an auto-picked one.
  if (
    c.primary_button &&
    !c.primary_button_label &&
    HEX.test(c.primary_button)
  ) {
    const w = darkContrastRatio(c.primary_button, "#ffffff");
    const b = darkContrastRatio(c.primary_button, "#000000");
    v["--ah-color-text-on-primary"] = b > w * 1.35 ? "#000000" : "#ffffff";
  }
  return v;
}

export type DarkVarsOptions = {
  /** The light theme's brand link colour; kept in dark (lightened if needed). */
  linkColor?: string;
  /** Explicit dark overrides; win over everything derived. */
  colorsDark?: ColorsDark;
};

/**
 * The dark CSS-variable set. Fallback order per variable: explicit
 * `colors_dark` value, then the derived value (stock dark palette plus
 * contrast adjustments of the brand colours), then the light value (the
 * variable is simply not set, so the light inline value stands).
 */
export function buildDarkVars(
  primaryColor?: string,
  opts: DarkVarsOptions = {},
): Record<string, string> {
  const vars: Record<string, string> = { ...DARK_MODE_CSS_VARS };
  const explicit = colorsDarkToCssVars(opts.colorsDark);
  const darkBg =
    explicit["--ah-color-bg"] ||
    DARK_MODE_CSS_VARS["--ah-color-bg"] ||
    "#1f2937";
  if (opts.linkColor) {
    vars["--ah-color-link"] = ensureDarkContrast(opts.linkColor, darkBg);
  }
  if (primaryColor) {
    if (darkContrastRatio(primaryColor, darkBg) < 3) {
      let adjusted = primaryColor;
      for (let i = 1; i <= 10; i++) {
        adjusted = lightenHexDark(primaryColor, i * 0.1);
        if (darkContrastRatio(adjusted, darkBg) >= 3) break;
      }
      vars["--ah-color-primary"] = adjusted;
      vars["--ah-color-primary-hover"] = adjusted;
    }
    const BIAS = 1.35;
    const btnBg = vars["--ah-color-primary"] || primaryColor;
    const whiteContrast = darkContrastRatio(btnBg, "#ffffff");
    const blackContrast = darkContrastRatio(btnBg, "#000000");
    vars["--ah-color-text-on-primary"] =
      blackContrast > whiteContrast * BIAS ? "#000000" : "#ffffff";
  }
  return { ...vars, ...explicit };
}

export function darkModeCssVarRules(
  selector: string,
  primaryColor?: string,
  opts: DarkVarsOptions = {},
): string {
  const props = Object.entries(buildDarkVars(primaryColor, opts))
    .map(([k, v]) => `${k}: ${v} !important`)
    .join("; ");
  return `${selector} { ${props}; }`;
}
