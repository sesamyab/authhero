/**
 * Dark-mode CSS variables and the contrast maths behind them.
 *
 * Pure functions, moved out of the authhero page module so the widget demo
 * renders the same dark mode the real login page does.
 */

import { NAMED_COLORS } from "./named-colors";

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

export type ParsedColor = { hex: string; alpha: number };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** One `rgb()` channel or alpha token: a number, or a percentage. */
function channel(token: string, full: number): number {
  return token.endsWith("%")
    ? (parseFloat(token) / 100) * full
    : parseFloat(token);
}

/** An `hsl()` hue in degrees; `turn`, `rad` and `grad` are converted. */
function hueDegrees(token: string): number {
  const n = parseFloat(token);
  if (token.endsWith("grad")) return n * 0.9;
  if (token.endsWith("turn")) return n * 360;
  if (token.endsWith("rad")) return (n * 180) / Math.PI;
  return n;
}

/**
 * Resolve any colour `sanitizeCssColor` accepts to `#rrggbb` plus alpha: hex
 * (with or without alpha), `rgb()`/`rgba()`, `hsl()`/`hsla()` and the common
 * named colours. Returns null for anything else (exotic names, malformed
 * values), so callers skip maths they cannot do instead of computing on
 * garbage.
 */
export function parseColor(color: string | undefined): ParsedColor | null {
  if (!color) return null;
  const v = color.trim().toLowerCase();
  if (HEX.test(v)) {
    const digits = v.slice(1);
    const long =
      digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
    const [r, g, b] = parseDarkHex(v);
    const alpha = long.length === 8 ? parseInt(long.slice(6), 16) / 255 : 1;
    return { hex: rgbToHex(r, g, b), alpha };
  }
  if (v === "transparent") return { hex: "#000000", alpha: 0 };
  // Own-property lookup: "constructor" and friends must not resolve.
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, v)) {
    const named = NAMED_COLORS[v];
    return typeof named === "string" ? { hex: named, alpha: 1 } : null;
  }
  const fn = v.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
  if (!fn) return null;
  const tokens = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 4) return null;
  const alpha = tokens[3] === undefined ? 1 : clamp01(channel(tokens[3], 1));
  if (Number.isNaN(alpha)) return null;
  if (fn[1]!.startsWith("rgb")) {
    const [r, g, b] = tokens.slice(0, 3).map((t) => channel(t, 255));
    if ([r, g, b].some((n) => n === undefined || Number.isNaN(n))) return null;
    return { hex: rgbToHex(r!, g!, b!), alpha };
  }
  const hue = hueDegrees(tokens[0]!);
  // CSS clamps a negative saturation to 0 before converting.
  const sat = Math.max(0, parseFloat(tokens[1]!) / 100);
  const light = parseFloat(tokens[2]!) / 100;
  if ([hue, sat, light].some((n) => Number.isNaN(n))) return null;
  const h = (((hue % 360) + 360) % 360) / 360;
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const f = (t: number) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    hex: rgbToHex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255),
    alpha,
  };
}

/** `#rrggbb` for any colour `parseColor` understands, else null. */
export function toHex(color: string | undefined): string | null {
  return parseColor(color)?.hex ?? null;
}

/** `fg` over `bg` at `alpha`, as `#rrggbb`. */
function compositeOver(fg: string, bg: string, alpha: number): string {
  const [fr, fgc, fb] = parseDarkHex(fg);
  const [br, bgc, bb] = parseDarkHex(bg);
  const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
  return rgbToHex(mix(fr, br), mix(fgc, bgc), mix(fb, bb));
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** True when the colour is light (would need dark text); false if unknown. */
export function isLightColor(color: string | undefined): boolean {
  const hex = toHex(color);
  return hex ? darkLuminance(hex) > 0.5 : false;
}

function darkenHexDark(hex: string, pct: number): string {
  const [r, g, b] = parseDarkHex(hex);
  return rgbToHex(r * (1 - pct), g * (1 - pct), b * (1 - pct));
}

/**
 * Adjust a brand colour until it reads on the card colour `bg` (contrast >=
 * `min`): lighten on a dark card, darken on a light one (a card set light in
 * dark via `colors_dark.widget_background`). Colours it cannot resolve are
 * returned as is. Used to keep the brand link colour in dark instead of
 * falling back to the stock blue.
 */
export function ensureDarkContrast(
  color: string,
  bg: string,
  min = 4.5,
): string {
  const fg = toHex(color);
  const surface = toHex(bg);
  if (!fg || !surface) return color;
  if (darkContrastRatio(fg, surface) >= min) return color;
  // Head for whichever endpoint can reach more contrast on this surface; a
  // luminance cut-off picks the wrong way for mid-tones.
  const towardLight =
    darkContrastRatio("#ffffff", surface) >=
    darkContrastRatio("#000000", surface);
  for (let i = 1; i <= 10; i++) {
    const adjusted = towardLight
      ? lightenHexDark(fg, i * 0.1)
      : darkenHexDark(fg, i * 0.1);
    if (darkContrastRatio(adjusted, surface) >= min) return adjusted;
  }
  return towardLight ? "#ffffff" : "#000000";
}

/**
 * Text colour for a button of colour `bg`. White is preferred on mid-tones
 * (BIAS), unless only black reaches the WCAG minimum of 4.5:1.
 */
function pickLabelColor(bg: string): string {
  const BIAS = 1.35;
  const white = darkContrastRatio(bg, "#ffffff");
  const black = darkContrastRatio(bg, "#000000");
  if (white < 4.5 && black >= 4.5) return "#000000";
  if (black < 4.5 && white >= 4.5) return "#ffffff";
  return black > white * BIAS ? "#000000" : "#ffffff";
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
  const explicitPrimary = parseColor(c.primary_button);
  if (explicitPrimary && !c.primary_button_label) {
    // A translucent button shows the card through it, so pick the label for
    // the colour the user actually sees.
    const card =
      toHex(c.widget_background) ||
      DARK_MODE_CSS_VARS["--ah-color-bg"] ||
      "#1f2937";
    const seen =
      explicitPrimary.alpha < 1
        ? compositeOver(explicitPrimary.hex, card, explicitPrimary.alpha)
        : explicitPrimary.hex;
    v["--ah-color-text-on-primary"] = pickLabelColor(seen);
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
    const btnBg = vars["--ah-color-primary"] || primaryColor;
    // The derived label keeps the plain bias rule on purpose: it is what
    // existing tenants (the default theme's #7D68F4 included) already render,
    // and the light scheme picks its label the same way. The stricter
    // pickLabelColor only applies to a primary the tenant set explicitly.
    const BIAS = 1.35;
    const whiteContrast = darkContrastRatio(btnBg, "#ffffff");
    const blackContrast = darkContrastRatio(btnBg, "#000000");
    vars["--ah-color-text-on-primary"] =
      blackContrast > whiteContrast * BIAS ? "#000000" : "#ffffff";
  }
  // An explicit primary we cannot resolve (an exotic colour name) and with no
  // explicit label has no label we can pick for it. Ignore it and keep the
  // derived primary, so colour and label always belong together. An explicit
  // label is the tenant's own choice and is applied as written.
  if (
    opts.colorsDark?.primary_button &&
    !opts.colorsDark.primary_button_label &&
    !toHex(opts.colorsDark.primary_button)
  ) {
    delete explicit["--ah-color-primary"];
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
