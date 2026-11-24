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
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%a-z\s,/]+\)$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/**
 * Whether a value is something the login page will accept as a colour. Hex
 * and rgb()/hsl() are checked syntactically; named colours go through
 * `CSS.supports` where the browser has it.
 */
export function isValidColor(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  if (isHexColor(v) || FUNCTIONAL.test(v)) return true;
  if (/^[a-z]+$/i.test(v)) {
    const css = (
      globalThis as { CSS?: { supports?: (...a: string[]) => boolean } }
    ).CSS;
    return typeof css?.supports === "function"
      ? css.supports("color", v)
      : false;
  }
  return false;
}

export function validateColor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return isValidColor(value)
    ? undefined
    : "Not a valid colour. Use a hex value such as #7D68F4.";
}

function parseHex(hex: string): [number, number, number] | null {
  if (!isHexColor(hex)) return null;
  let v = hex.slice(1);
  if (v.length <= 4) v = [...v].map((d) => d + d).join("");
  const n = parseInt(v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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

/** WCAG contrast ratio, or null when either value isn't a parseable hex. */
export function contrastRatio(a: string, b: string): number | null {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return null;
  const la = luminance(pa);
  const lb = luminance(pb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mix `hex` towards `target` by `amount` (0..1). */
export function mixHex(hex: string, target: string, amount: number): string {
  const a = parseHex(hex);
  const b = parseHex(target);
  if (!a || !b) return hex;
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
