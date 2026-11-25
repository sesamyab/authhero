import { Kysely } from "kysely";
import { removeNullProperties } from "../helpers/remove-nulls";
import { Theme } from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { unflattenObject } from "../utils/flatten";

// Font detail groups are stored as `fonts_<group>_bold` / `fonts_<group>_size`
// columns. unflattenObject only splits one level, so without this step they
// would come back as `fonts.body_text_bold` instead of `fonts.body_text.bold`.
const FONT_DETAIL_KEYS = [
  "body_text",
  "buttons_text",
  "input_labels",
  "links",
  "subtitle",
  "title",
] as const;

function nestFontDetails(fonts: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...fonts };
  for (const key of FONT_DETAIL_KEYS) {
    const bold = result[`${key}_bold`];
    const size = result[`${key}_size`];
    delete result[`${key}_bold`];
    delete result[`${key}_size`];
    if (bold === undefined && size === undefined) continue;
    result[key] = { bold, size };
  }
  return result;
}

export function get(db: Kysely<Database>) {
  return async (tenant_id: string, themeId: string): Promise<Theme | null> => {
    const theme = await db
      .selectFrom("themes")
      .where("themes.tenant_id", "=", tenant_id)
      .where("themes.themeId", "=", themeId)
      .selectAll()
      .executeTakeFirst();

    if (!theme) {
      return null;
    }

    // Convert integer boolean fields from PlanetScale to actual booleans
    const convertedTheme = {
      ...theme,
      borders_show_widget_shadow: Boolean(theme.borders_show_widget_shadow),
      fonts_body_text_bold: Boolean(theme.fonts_body_text_bold),
      fonts_buttons_text_bold: Boolean(theme.fonts_buttons_text_bold),
      fonts_input_labels_bold: Boolean(theme.fonts_input_labels_bold),
      fonts_links_bold: Boolean(theme.fonts_links_bold),
      fonts_subtitle_bold: Boolean(theme.fonts_subtitle_bold),
      fonts_title_bold: Boolean(theme.fonts_title_bold),
    };

    const unflattened = unflattenObject(convertedTheme, [
      "widget",
      // Before "colors": first matching prefix wins.
      "colors_dark",
      "colors",
      "borders",
      "fonts",
      "page_background",
    ]);
    if (unflattened.fonts) {
      unflattened.fonts = nestFontDetails(unflattened.fonts);
    }
    const result = removeNullProperties(unflattened) as Theme;

    // Rows stored before the dark fields existed have all colors_dark_*
    // columns NULL; report "no dark overrides" rather than an empty object.
    if (result.colors_dark && Object.keys(result.colors_dark).length === 0) {
      delete result.colors_dark;
    }
    return result;
  };
}
