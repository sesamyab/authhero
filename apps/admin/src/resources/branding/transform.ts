import { completeLightColors, type ThemeColors } from "./theme-colors";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Enum-valued string fields. An empty string isn't a valid value for these,
 * so a cleared select is left unchanged instead of being sent as "".
 */
const ENUM_KEYS = new Set([
  "dark_mode",
  "captcha_widget_theme",
  "page_layout",
  "logo_placement",
  "header_text_alignment",
  "logo_position",
  "social_buttons_layout",
  "buttons_style",
  "inputs_style",
  "links_style",
  "type",
  "themeId",
]);

/**
 * Prepare a PATCH payload.
 *
 * The API merges a PATCH into what is stored, so a key that is left out keeps
 * its old value. ra-core turns a cleared text input into `null`, and dropping
 * those (as this used to) meant clearing a field never saved. A string that
 * was set in `previous` and is now empty/null/missing is therefore sent as
 * `""`, which the server treats as unset (this is also how a dark override goes
 * back to "same as light / derived"). Numbers and enums can't be cleared with
 * `""`, so those are still omitted.
 */
export function cleanObject(obj: Obj, previous?: unknown): Obj {
  const prev = isObj(previous) ? previous : {};
  const result: Obj = {};

  for (const [key, value] of Object.entries(obj)) {
    const before = prev[key];
    if (value === null || value === undefined || value === "") {
      const clearable = !ENUM_KEYS.has(key);
      // Cleared (or already empty) string: send "" so the server unsets it.
      if (
        clearable &&
        (value === "" || (typeof before === "string" && before !== ""))
      ) {
        result[key] = "";
      }
      continue;
    }
    if (isObj(value)) {
      const cleaned = cleanObject(value, before);
      if (Object.keys(cleaned).length > 0) result[key] = cleaned;
    } else {
      result[key] = value;
    }
  }

  // Whole sub-objects that disappeared from the form (e.g. colors_dark once
  // every override is cleared): clear what was set inside them.
  for (const [key, before] of Object.entries(prev)) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) continue;
    if (isObj(before)) {
      const nested = clearStrings(before);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else if (
      typeof before === "string" &&
      before !== "" &&
      !ENUM_KEYS.has(key) &&
      !(key in result)
    ) {
      result[key] = "";
    }
  }
  return result;
}

/** `""` for every clearable string inside `before`. */
function clearStrings(before: Obj): Obj {
  const out: Obj = {};
  for (const [key, v] of Object.entries(before)) {
    if (isObj(v)) {
      const nested = clearStrings(v);
      if (Object.keys(nested).length) out[key] = nested;
    } else if (typeof v === "string" && v !== "" && !ENUM_KEYS.has(key)) {
      out[key] = "";
    }
  }
  return out;
}

export function transformBranding(
  data: Obj,
  options?: { previousData?: Obj },
): Obj {
  const previous = options?.previousData;
  const result = cleanObject(data, previous);

  const font = result.font;
  const hadFontUrl =
    isObj(previous?.font) && typeof previous.font.url === "string"
      ? previous.font.url !== ""
      : false;
  if (isObj(font) && !font.url && !hadFontUrl) {
    delete result.font;
  }

  // The schema requires the full light palette. The simple view only edits a
  // small core, so make sure the rest is filled (and that a cleared light
  // colour falls back to a derived value instead of failing validation).
  const themes = result.themes;
  if (isObj(themes) && isObj(themes.colors)) {
    themes.colors = {
      ...themes.colors,
      ...completeLightColors(themes.colors as ThemeColors),
    };
  }
  return result;
}
