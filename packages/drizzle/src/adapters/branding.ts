import { eq } from "drizzle-orm";
import type { Branding } from "@authhero/adapter-interfaces";
import { branding } from "../schema/sqlite";
import { removeNullProperties } from "../helpers/transform";
import type { DrizzleDb } from "./types";

function isDarkMode(value: unknown): value is "dark" | "light" | "auto" {
  return value === "dark" || value === "light" || value === "auto";
}

export function createBrandingAdapter(db: DrizzleDb) {
  return {
    async get(tenant_id: string): Promise<Branding | null> {
      const result = await db
        .select()
        .from(branding)
        .where(eq(branding.tenant_id, tenant_id))
        .get();

      if (!result) return null;

      const {
        tenant_id: _,
        colors_primary,
        colors_page_background_type,
        colors_page_background_start,
        colors_page_background_end,
        colors_page_background_angle_dev,
        font_url,
        dark_mode,
        ...rest
      } = result;

      return removeNullProperties({
        ...rest,
        colors: {
          primary: colors_primary,
          page_background: {
            type: colors_page_background_type,
            start: colors_page_background_start,
            end: colors_page_background_end,
            angle_deg: colors_page_background_angle_dev,
          },
        },
        font: font_url ? { url: font_url } : undefined,
        dark_mode: isDarkMode(dark_mode) ? dark_mode : undefined,
      });
    },

    async set(tenant_id: string, data: Branding): Promise<void> {
      const { colors, font, dark_mode, ...rest } = data;

      // Auth0 allows page_background to be either a hex string or a gradient
      // object. Persist gradient fields only when an object is provided.
      const pageBackground = colors?.page_background;
      const gradient =
        pageBackground && typeof pageBackground === "object"
          ? pageBackground
          : undefined;

      const flatValues = {
        ...rest,
        colors_primary: colors?.primary,
        colors_page_background_type: gradient?.type,
        colors_page_background_start: gradient?.start,
        colors_page_background_end: gradient?.end,
        colors_page_background_angle_dev: gradient?.angle_deg,
        font_url: font?.url,
        dark_mode,
      };

      await db
        .insert(branding)
        .values({ tenant_id, ...flatValues })
        .onConflictDoUpdate({
          target: branding.tenant_id,
          set: flatValues,
        });
    },
  };
}
