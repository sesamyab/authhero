import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Theme, CreateOptions } from "@authhero/adapter-interfaces";
import { themes } from "../schema/sqlite";
import {
  removeNullProperties,
  flattenObject,
  unflattenObject,
} from "../helpers/transform";
import type { DrizzleDb } from "./types";

// "colors_dark" must come before "colors": unflattenObject takes the first
// matching prefix, and `colors_dark_*` also starts with `colors_`.
const UNFLATTEN_PREFIXES = [
  "colors_dark",
  "colors",
  "borders",
  "fonts",
  "page_background",
  "widget",
];

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
    result[key] = {
      // SQLite stores booleans as integers
      bold: bold === null || bold === undefined ? bold : !!bold,
      size,
    };
  }
  return result;
}

function sqlToTheme(row: any): Theme {
  const { tenant_id: _, ...rest } = row;
  const unflattened = unflattenObject(rest, UNFLATTEN_PREFIXES);

  // Convert integer booleans in nested objects
  if (unflattened.borders) {
    unflattened.borders.show_widget_shadow =
      !!unflattened.borders.show_widget_shadow;
  }
  if (unflattened.fonts) {
    unflattened.fonts = nestFontDetails(unflattened.fonts);
  }

  const theme = removeNullProperties(unflattened) as Theme;
  // Rows stored before the dark fields existed have all colors_dark_*
  // columns NULL; report "no dark overrides" rather than an empty object.
  if (theme.colors_dark && Object.keys(theme.colors_dark).length === 0) {
    delete theme.colors_dark;
  }
  return theme;
}

export function createThemesAdapter(db: DrizzleDb) {
  return {
    async create(
      tenant_id: string,
      theme: any,
      themeId?: string,
      options?: CreateOptions,
    ): Promise<Theme> {
      const importMetadata = options?.importMetadata;
      const now = new Date().toISOString();
      // `importMetadata.id` takes precedence over the positional themeId so
      // imports preserve source ids consistently across adapters.
      const id = importMetadata?.id || themeId || nanoid();

      const flattened = flattenObject(theme);
      const values = {
        ...flattened,
        tenant_id,
        themeId: id,
        created_at: importMetadata?.created_at ?? now,
        updated_at: importMetadata?.updated_at ?? now,
      };

      await db.insert(themes).values(values as any);

      return sqlToTheme({ ...values, tenant_id });
    },

    async get(tenant_id: string, themeId: string): Promise<Theme | null> {
      const result = await db
        .select()
        .from(themes)
        .where(
          and(eq(themes.tenant_id, tenant_id), eq(themes.themeId, themeId)),
        )
        .get();

      if (!result) return null;
      return sqlToTheme(result);
    },

    async update(
      tenant_id: string,
      themeId: string,
      params: Partial<Theme>,
    ): Promise<boolean> {
      const flattened = flattenObject(params);
      flattened.updated_at = new Date().toISOString();

      await db
        .update(themes)
        .set(flattened as any)
        .where(
          and(eq(themes.tenant_id, tenant_id), eq(themes.themeId, themeId)),
        );

      return true;
    },

    async remove(tenant_id: string, themeId: string): Promise<boolean> {
      const results = await db
        .delete(themes)
        .where(
          and(eq(themes.tenant_id, tenant_id), eq(themes.themeId, themeId)),
        )
        .returning();

      return results.length > 0;
    },
  };
}
