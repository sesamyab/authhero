/**
 * Pure colour helpers for the branding editor: validation, WCAG contrast,
 * and the derivations that let a small "core" palette fill the full one.
 *
 * Dark derivation is an admin-side approximation of the server's derived dark
 * palette (`DARK_MODE_CSS_VARS` in `packages/ui-widget/src/page-chrome`). The
 * admin does not depend on `@authhero/widget`, so the constants are mirrored
 * here. It only seeds the "Generate dark from light" action; the server still
 * resolves any unset dark field itself.
 */

export type ThemeColors = Record<string, string | undefined>;

/** The colours the simple view edits. Everything else is derived. */
export const CORE_COLOR_KEYS = [
  "primary_button",
  "widget_background",
  "body_text",
  "links_focused_components",
  "widget_border",
  "error",
] as const;

/** Every colour in `themes.colors` except `captcha_widget_theme`. */
export const ALL_COLOR_KEYS = [
  "base_focus_color",
  "base_hover_color",
  "body_text",
  "error",
  "header",
  "icons",
  "input_background",
  "input_border",
  "input_filled_text",
  "input_labels_placeholders",
  "links_focused_components",
  "primary_button",
  "primary_button_label",
  "secondary_button_border",
  "secondary_button_label",
  "success",
  "widget_background",
  "widget_border",
] as const;

/** Mirrors DEFAULT_THEME.colors in authhero (used to fill missing values). */
export const DEFAULT_LIGHT_COLORS: Record<string, string> = {
  base_focus_color: "#7D68F4",
  base_hover_color: "#A091F2",
  body_text: "#000000",
  error: "#FC5A5A",
  header: "#000000",
  icons: "#666666",
  input_background: "#FFFFFF",
  input_border: "#8E8CA0",
  input_filled_text: "#000000",
  input_labels_placeholders: "#88869F",
  links_focused_components: "#7D68F4",
  primary_button: "#7D68F4",
  primary_button_label: "#FFFFFF",
  secondary_button_border: "#8E8CA0",
  secondary_button_label: "#000000",
  success: "#36BF76",
  widget_background: "#FFFFFF",
  widget_border: "#8E8CA0",
};

export const DEFAULT_PAGE_BACKGROUND = "#F8F9FB";
export const DEFAULT_DARK_PAGE_BACKGROUND = "#111827";

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

type Rgba = { rgb: [number, number, number]; alpha: number };

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

/** A number or percentage, scaled so 100% === `scale`. null when malformed. */
function component(token: string, scale: number): number | null {
  if (token.endsWith("%")) {
    const n = token.slice(0, -1);
    return NUM.test(n) ? (parseFloat(n) / 100) * scale : null;
  }
  return NUM.test(token) ? parseFloat(token) : null;
}

function alphaOf(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const a = component(token, 1);
  return a === null ? null : Math.max(0, Math.min(1, a));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    return (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

/** Strict rgb()/hsl() parser (comma or space syntax, optional alpha). */
function parseFunctional(value: string): Rgba | null {
  const m = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/i.exec(value.trim());
  if (!m) return null;
  const fn = m[1]!.toLowerCase();
  const parts = m[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = alphaOf(parts[3]);
  if (alpha === null) return null;
  if (fn.startsWith("rgb")) {
    const c = parts.slice(0, 3).map((p) => component(p, 255));
    if (c.some((n) => n === null)) return null;
    // CSS clamps out-of-range channels, so rgb(1000 1000 1000) is white.
    const [r, g, b] = (c as number[]).map((n) => Math.max(0, Math.min(255, n)));
    return { rgb: [r!, g!, b!], alpha };
  }
  const hue = /^([-+]?(?:\d+\.?\d*|\.\d+))(?:deg)?$/i.exec(parts[0]!);
  // Legacy comma syntax needs percentages; the modern space syntax also
  // accepts plain numbers on the 0-100 scale (hsl(0 0 100) is white).
  const legacy = m[2]!.includes(",");
  const pct = (t: string) =>
    t.endsWith("%")
      ? component(t, 1)
      : legacy
        ? null
        : NUM.test(t)
          ? parseFloat(t) / 100
          : null;
  const s = pct(parts[1]!);
  const l = pct(parts[2]!);
  if (!hue || s === null || l === null) return null;
  return { rgb: hslToRgb(parseFloat(hue[1]!), s, l), alpha };
}

function cssSupports(value: string): boolean | undefined {
  const css = (
    globalThis as { CSS?: { supports?: (...a: string[]) => boolean } }
  ).CSS;
  return typeof css?.supports === "function"
    ? css.supports("color", value)
    : undefined;
}

/** Resolve a named colour through the browser; null where that isn't possible. */
function parseNamed(value: string): Rgba | null {
  if (typeof document === "undefined" || cssSupports(value) !== true) {
    return null;
  }
  const el = document.createElement("span");
  el.style.color = value;
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return /^rgba?\(/.test(resolved) ? parseFunctional(resolved) : null;
}

function parseHex(hex: string): Rgba | null {
  if (!isHexColor(hex)) return null;
  let v = hex.slice(1);
  if (v.length <= 4) v = [...v].map((d) => d + d).join("");
  const n = parseInt(v.slice(0, 6), 16);
  const alpha = v.length === 8 ? parseInt(v.slice(6), 16) / 255 : 1;
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha };
}

/** Any colour this editor accepts (hex, rgb(), hsl(), named) as RGB + alpha. */
function parseColor(value: string): Rgba | null {
  const v = value.trim();
  if (v.startsWith("#")) return parseHex(v);
  if (/^[a-z]+$/i.test(v)) return parseNamed(v);
  return parseFunctional(v);
}

/**
 * Whether a value is something the login page will accept as a colour. Hex is
 * checked syntactically, rgb()/hsl() against a strict grammar (and the browser
 * where it can tell us), named colours through `CSS.supports`.
 */
export function isValidColor(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  if (isHexColor(v)) return true;
  if (/^[a-z]+$/i.test(v)) return cssSupports(v) === true;
  return parseFunctional(v) !== null;
}

export function validateColor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return isValidColor(value)
    ? undefined
    : "Not a valid colour. Use a hex value such as #7D68F4.";
}

function toHexString([r, g, b]: [number, number, number]): string {
  const f = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`.toUpperCase();
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, or null when either value isn't an opaque, parseable colour. */
export function contrastRatio(a: string, b: string): number | null {
  const pa = parseColor(a);
  const pb = parseColor(b);
  // Translucent colours have no fixed contrast without knowing what's behind
  // them, so they are skipped rather than miscounted as opaque.
  if (!pa || !pb || pa.alpha < 1 || pb.alpha < 1) return null;
  const la = luminance(pa.rgb);
  const lb = luminance(pb.rgb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Normalise any accepted colour to `#RRGGBB`; null if opaque parsing fails. */
export function toHex(value: string): string | null {
  const p = parseColor(value);
  return p && p.alpha === 1 ? toHexString(p.rgb) : null;
}

/** Mix `hex` towards `target` by `amount` (0..1). */
export function mixHex(hex: string, target: string, amount: number): string {
  const pa = parseColor(hex);
  const pb = parseColor(target);
  if (!pa || !pb) return hex;
  const a = pa.rgb;
  const b = pb.rgb;
  return toHexString([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/** White unless it would be hard to read on `bg`, then black. */
export function pickLabelColor(bg: string): string {
  const white = contrastRatio("#FFFFFF", bg);
  if (white === null) return "#FFFFFF";
  return white >= 3 ? "#FFFFFF" : "#000000";
}

// ---------------------------------------------------------------------------
// Contrast warnings
// ---------------------------------------------------------------------------

type Pair = { fg: string; bg: string; label: string; min: number };

const CONTRAST_PAIRS: Pair[] = [
  {
    fg: "body_text",
    bg: "widget_background",
    label: "Body text on widget background",
    min: 4.5,
  },
  {
    fg: "header",
    bg: "widget_background",
    label: "Header on widget background",
    min: 4.5,
  },
  {
    fg: "links_focused_components",
    bg: "widget_background",
    label: "Links on widget background",
    min: 4.5,
  },
  {
    fg: "error",
    bg: "widget_background",
    label: "Error text on widget background",
    min: 4.5,
  },
  {
    fg: "primary_button_label",
    bg: "primary_button",
    label: "Primary button label on button",
    // Bold UI text; the default brand purple/white pair is 4.1:1.
    min: 3,
  },
  {
    fg: "input_filled_text",
    bg: "input_background",
    label: "Input text on input background",
    min: 4.5,
  },
  {
    fg: "input_labels_placeholders",
    bg: "input_background",
    label: "Input labels/placeholders on input background",
    min: 4.5,
  },
  {
    fg: "secondary_button_label",
    bg: "widget_background",
    label: "Secondary button label on widget background",
    min: 4.5,
  },
  {
    // WCAG 1.4.11: UI component boundaries need 3:1.
    fg: "input_border",
    bg: "input_background",
    label: "Input border on input background",
    min: 3,
  },
];

export type ContrastWarning = {
  label: string;
  ratio: number;
  min: number;
  fg: string;
  bg: string;
};

/**
 * WCAG warnings for a full palette. Pairs where either colour is missing or
 * isn't a hex value are skipped (we can't compute them reliably).
 */
export function contrastWarnings(colors: ThemeColors): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  for (const p of CONTRAST_PAIRS) {
    const fg = colors[p.fg];
    const bg = colors[p.bg];
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio < p.min) {
      out.push({ label: p.label, ratio, min: p.min, fg, bg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Colours that follow the core palette in the simple view. Returns a value for
 * each dependent key; core keys are not included.
 */
export function deriveDependentColors(
  core: ThemeColors,
): Record<string, string> {
  const primary = core.primary_button || DEFAULT_LIGHT_COLORS.primary_button!;
  const text = core.body_text || DEFAULT_LIGHT_COLORS.body_text!;
  const card =
    core.widget_background || DEFAULT_LIGHT_COLORS.widget_background!;
  const border = core.widget_border || DEFAULT_LIGHT_COLORS.widget_border!;
  return {
    primary_button_label: pickLabelColor(primary),
    base_focus_color: primary,
    base_hover_color: mixHex(primary, "#FFFFFF", 0.27),
    header: text,
    input_filled_text: text,
    secondary_button_label: text,
    secondary_button_border: border,
    input_border: border,
    input_background: card,
  };
}

/**
 * Fill every missing light colour: derived from the core where there's a
 * dependency, otherwise the default theme value. The schema requires the full
 * light palette, so the simple view relies on this when it saves.
 */
export function completeLightColors(
  colors: ThemeColors | undefined,
): ThemeColors {
  const src = colors ?? {};
  const get = (k: string) => (src[k] ? src[k] : undefined);
  const core: ThemeColors = {};
  for (const k of CORE_COLOR_KEYS) core[k] = get(k) ?? DEFAULT_LIGHT_COLORS[k];
  const derived = deriveDependentColors(core);
  const out: ThemeColors = { ...src };
  for (const k of ALL_COLOR_KEYS) {
    out[k] = get(k) ?? core[k] ?? derived[k] ?? DEFAULT_LIGHT_COLORS[k];
  }
  return out;
}

const DARK_BASE: Record<string, string> = {
  body_text: "#F9FAFB",
  header: "#F9FAFB",
  input_filled_text: "#F9FAFB",
  secondary_button_label: "#F9FAFB",
  input_labels_placeholders: "#C1C7D0",
  widget_background: "#1F2937",
  input_background: "#374151",
  // Input and button outlines need 3:1 against their surface (WCAG 1.4.11).
  input_border: "#9CA3AF",
  widget_border: "#4B5563",
  secondary_button_border: "#9CA3AF",
  icons: "#D1D5DB",
};

/**
 * A dark palette from a light one: neutrals come from the same dark surface
 * palette the server uses; brand colours (primary, focus, hover, links,
 * error, success) are kept and lightened until they read on the dark card.
 */
export function generateDarkFromLight(light: ThemeColors): ThemeColors {
  const full = completeLightColors(light);
  const card = DARK_BASE.widget_background!;
  const readable = (hex: string, min: number) => {
    let c = hex;
    for (let i = 0; i < 10; i++) {
      const r = contrastRatio(c, card);
      if (r === null || r >= min) break;
      c = mixHex(c, "#FFFFFF", 0.15);
    }
    return c;
  };
  const primary = full.primary_button!;
  return {
    ...DARK_BASE,
    primary_button: primary,
    primary_button_label: pickLabelColor(primary),
    base_focus_color: full.base_focus_color!,
    base_hover_color: mixHex(primary, "#FFFFFF", 0.27),
    links_focused_components: readable(full.links_focused_components!, 4.5),
    error: readable(full.error!, 3),
    success: readable(full.success!, 3),
  };
}
