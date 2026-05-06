import { Branding } from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";

export function set(db: Kysely<Database>) {
  return async (tenant_id: string, branding: Branding) => {
    const { colors, font, ...rest } = branding;

    // Auth0 allows page_background to be either a hex string or a gradient
    // object. Persist gradient fields only when an object is provided.
    const pageBackground = colors?.page_background;
    const gradient =
      pageBackground && typeof pageBackground === "object"
        ? pageBackground
        : undefined;

    try {
      await db
        .insertInto("branding")
        .values({
          ...rest,
          colors_primary: colors?.primary,
          colors_page_background_type: gradient?.type,
          colors_page_background_start: gradient?.start,
          colors_page_background_end: gradient?.end,
          colors_page_background_angle_dev: gradient?.angle_deg,
          font_url: branding.font?.url,
          tenant_id,
        })
        .execute();
    } catch (error) {
      await db
        .updateTable("branding")
        .set({
          ...rest,
          colors_primary: colors?.primary,
          colors_page_background_type: gradient?.type,
          colors_page_background_start: gradient?.start,
          colors_page_background_end: gradient?.end,
          colors_page_background_angle_dev: gradient?.angle_deg,
          font_url: branding.font?.url,
        })
        .where("tenant_id", "=", tenant_id)
        .execute();
    }
  };
}
