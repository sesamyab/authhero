import { z } from "@hono/zod-openapi";

export const bordersSchema = z.object({
  button_border_radius: z.number(),
  button_border_weight: z.number(),
  buttons_style: z.enum(["pill", "rounded", "sharp"]),
  input_border_radius: z.number(),
  input_border_weight: z.number(),
  inputs_style: z.enum(["pill", "rounded", "sharp"]),
  show_widget_shadow: z.boolean(),
  widget_border_weight: z.number(),
  widget_corner_radius: z.number(),
});

export const colorsSchema = z.object({
  base_focus_color: z.string(),
  base_hover_color: z.string(),
  body_text: z.string(),
  captcha_widget_theme: z.enum(["auto", "dark", "light"]),
  error: z.string(),
  header: z.string(),
  icons: z.string(),
  input_background: z.string(),
  input_border: z.string(),
  input_filled_text: z.string(),
  input_labels_placeholders: z.string(),
  links_focused_components: z.string(),
  primary_button: z.string(),
  primary_button_label: z.string(),
  secondary_button_border: z.string(),
  secondary_button_label: z.string(),
  success: z.string(),
  widget_background: z.string(),
  widget_border: z.string(),
});

/**
 * Optional dark-scheme overrides for `colors` (AuthHero extension; Auth0 has
 * a single palette). Only the keys that should differ in dark need to be set.
 * Rendering falls back per key: explicit dark value, then the derived dark
 * palette, then the light value. `captcha_widget_theme` is a scheme setting
 * itself, so it has no dark override.
 */
export const colorsDarkSchema = colorsSchema
  .omit({ captcha_widget_theme: true })
  .partial();

export const fontDetailsSchema = z.object({
  bold: z.boolean(),
  size: z.number(),
});

export const fontsSchema = z.object({
  body_text: fontDetailsSchema,
  buttons_text: fontDetailsSchema,
  font_url: z.string(),
  input_labels: fontDetailsSchema,
  links: fontDetailsSchema,
  links_style: z.enum(["normal", "underlined"]),
  reference_text_size: z.number(),
  subtitle: fontDetailsSchema,
  title: fontDetailsSchema,
});

export const pageBackgroundSchema = z.object({
  background_color: z.string(),
  background_image_url: z.string(),
  /** AuthHero extension: page background colour used in the dark scheme. */
  background_color_dark: z.string().optional(),
  /** AuthHero extension: page background image used in the dark scheme. */
  background_image_url_dark: z.string().optional(),
  page_layout: z.enum(["center", "left", "right"]),
  /**
   * Where the tenant logo renders on the page.
   * - "widget" (default): inside the widget card via the widget's own header.
   * - "chip": as a floating pill in the top-left page corner. The widget's
   *   internal logo is suppressed when this is selected.
   * - "none": no logo on the page or in the widget.
   * Optional for backwards compatibility; absent values mean "widget".
   */
  logo_placement: z.enum(["widget", "chip", "none"]).optional(),
});

export const widgetSchema = z.object({
  header_text_alignment: z.enum(["center", "left", "right"]),
  logo_height: z.number(),
  logo_position: z.enum(["center", "left", "none", "right"]),
  logo_url: z.string(),
  /** AuthHero extension: logo used in the dark scheme. */
  logo_url_dark: z.string().optional(),
  social_buttons_layout: z.enum(["bottom", "top"]),
});

export const themeInsertSchema = z.object({
  borders: bordersSchema,
  colors: colorsSchema,
  /** AuthHero extension (optional): dark-scheme overrides of `colors`. */
  colors_dark: colorsDarkSchema.optional(),
  displayName: z.string(),
  fonts: fontsSchema,
  page_background: pageBackgroundSchema,
  widget: widgetSchema,
});

export type ThemeInsert = z.input<typeof themeInsertSchema>;

export const themeSchema = themeInsertSchema.extend({
  themeId: z.string(),
});

export type Theme = z.infer<typeof themeSchema>;
