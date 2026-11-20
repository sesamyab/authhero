import { Kysely, sql } from "kysely";
import { Database } from "../../src/db";

/**
 * Dark-scheme extension of themes (#1740): `colors_dark_*` overrides, a dark
 * logo and a dark page background colour/image. All nullable; existing rows
 * read back without them and render exactly as before. Auth0 has no dark
 * variants, so these are AuthHero-only. Also adds `favicon_url_dark` to
 * branding.
 */
const THEME_COLUMNS: [string, number][] = [
  ["colors_dark_base_focus_color", 24],
  ["colors_dark_base_hover_color", 24],
  ["colors_dark_body_text", 24],
  ["colors_dark_error", 24],
  ["colors_dark_header", 24],
  ["colors_dark_icons", 24],
  ["colors_dark_input_background", 24],
  ["colors_dark_input_border", 24],
  ["colors_dark_input_filled_text", 24],
  ["colors_dark_input_labels_placeholders", 24],
  ["colors_dark_links_focused_components", 24],
  ["colors_dark_primary_button", 24],
  ["colors_dark_primary_button_label", 24],
  ["colors_dark_secondary_button_border", 24],
  ["colors_dark_secondary_button_label", 24],
  ["colors_dark_success", 24],
  ["colors_dark_widget_background", 24],
  ["colors_dark_widget_border", 24],
  ["page_background_background_color_dark", 24],
  ["page_background_background_image_url_dark", 255],
  ["widget_logo_url_dark", 255],
];

function isDuplicateColumn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("1060") ||
      error.message.toLowerCase().includes("duplicate column"))
  );
}

function isMissingColumn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("errno" in error && error.errno === 1091) ||
      ("code" in error && error.code === "ER_CANT_DROP_FIELD_OR_KEY") ||
      error.message.includes("1091") ||
      error.message.toLowerCase().includes("no such column"))
  );
}

async function addColumn(
  db: Kysely<Database>,
  table: string,
  column: string,
  length: number,
): Promise<void> {
  try {
    await db.schema
      .alterTable(table)
      .addColumn(column, sql`varchar(${sql.raw(String(length))})`)
      .execute();
  } catch (error: unknown) {
    // Tolerate "duplicate column" so a re-run is safe.
    if (!isDuplicateColumn(error)) throw error;
  }
}

async function dropColumn(
  db: Kysely<Database>,
  table: string,
  column: string,
): Promise<void> {
  try {
    await db.schema.alterTable(table).dropColumn(column).execute();
  } catch (error: unknown) {
    if (!isMissingColumn(error)) throw error;
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  for (const [column, length] of THEME_COLUMNS) {
    await addColumn(db, "themes", column, length);
  }
  await addColumn(db, "branding", "favicon_url_dark", 512);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await dropColumn(db, "branding", "favicon_url_dark");
  for (const [column] of [...THEME_COLUMNS].reverse()) {
    await dropColumn(db, "themes", column);
  }
}
