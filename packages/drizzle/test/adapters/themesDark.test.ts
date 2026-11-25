import { describe, expect, it } from "vitest";
import { themeSchema } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

const baseTheme = {
  displayName: "Dark Theme",
  colors: {
    primary_button: "#007bff",
    primary_button_label: "#ffffff",
    secondary_button_border: "#6c757d",
    secondary_button_label: "#6c757d",
    base_focus_color: "#007bff",
    base_hover_color: "#0056b3",
    body_text: "#212529",
    captcha_widget_theme: "auto" as const,
    error: "#dc3545",
    header: "#212529",
    icons: "#6c757d",
    input_background: "#ffffff",
    input_border: "#ced4da",
    input_filled_text: "#495057",
    input_labels_placeholders: "#6c757d",
    links_focused_components: "#007bff",
    success: "#28a745",
    widget_background: "#ffffff",
    widget_border: "#dee2e6",
  },
  borders: {
    button_border_radius: 4,
    button_border_weight: 1,
    buttons_style: "pill" as const,
    input_border_radius: 4,
    input_border_weight: 1,
    inputs_style: "pill" as const,
    show_widget_shadow: true,
    widget_border_weight: 1,
    widget_corner_radius: 8,
  },
  fonts: {
    body_text: { bold: false, size: 14 },
    buttons_text: { bold: true, size: 16 },
    font_url: "https://example.com/font.css",
    input_labels: { bold: false, size: 12 },
    links: { bold: false, size: 14 },
    links_style: "normal" as const,
    reference_text_size: 14,
    subtitle: { bold: false, size: 16 },
    title: { bold: true, size: 24 },
  },
  page_background: {
    background_color: "#f8f9fa",
    background_image_url: "",
    page_layout: "center" as const,
  },
  widget: {
    header_text_alignment: "center" as const,
    logo_height: 60,
    logo_position: "center" as const,
    logo_url: "https://example.com/logo.png",
    social_buttons_layout: "bottom" as const,
  },
};

const dark = {
  colors_dark: {
    widget_background: "#101827",
    // 26 characters: longer than the 24 of the light colour columns
    links_focused_components: "rgba(255, 255, 255, 0.125)",
  },
  page_background: {
    ...baseTheme.page_background,
    background_color_dark: "#0b0f19",
    background_image_url_dark: "https://example.com/bg-dark.jpg",
  },
  widget: {
    ...baseTheme.widget,
    logo_url_dark: "https://example.com/logo-dark.png",
  },
};

describe("themes dark fields", () => {
  it("round-trips the optional dark fields without leaking into colors", async () => {
    const { data } = getTestServer();
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });

    const created = await data.themes.create("tenantId", {
      ...baseTheme,
      ...dark,
    });
    const theme = await data.themes.get("tenantId", created.themeId);

    expect(theme!.colors_dark).toEqual(dark.colors_dark);
    expect(theme!.colors).toEqual(baseTheme.colors);
    expect(theme!.colors).not.toHaveProperty("dark_widget_background");
    expect(theme!.page_background).toMatchObject({
      background_color_dark: "#0b0f19",
      background_image_url_dark: "https://example.com/bg-dark.jpg",
    });
    expect(theme!.widget.logo_url_dark).toBe(
      "https://example.com/logo-dark.png",
    );

    // Update only a dark colour.
    await data.themes.update("tenantId", created.themeId, {
      colors_dark: { ...dark.colors_dark, links_focused_components: "#00ff00" },
    });
    const updated = await data.themes.get("tenantId", created.themeId);
    expect(updated!.colors_dark?.links_focused_components).toBe("#00ff00");
    expect(updated!.colors_dark?.widget_background).toBe("#101827");
  });

  it("reads back a theme stored without dark fields unchanged", async () => {
    const { data } = getTestServer();
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });

    const created = await data.themes.create("tenantId", baseTheme);
    const theme = await data.themes.get("tenantId", created.themeId);

    expect(theme!.colors_dark).toBeUndefined();
    expect(theme!.widget).not.toHaveProperty("logo_url_dark");
    expect(theme!.page_background).not.toHaveProperty("background_color_dark");
  });
});

describe("themes fonts", () => {
  it("round-trips nested font details losslessly", async () => {
    const { data } = await getTestServer();
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });

    const created = await data.themes.create("tenantId", baseTheme);
    expect(created.fonts).toEqual(baseTheme.fonts);

    const theme = await data.themes.get("tenantId", created.themeId);
    expect(theme!.fonts).toEqual(baseTheme.fonts);
    expect(theme!.fonts).not.toHaveProperty("body_text_bold");
    expect(themeSchema.safeParse(theme).success).toBe(true);

    // A partial update of one font group keeps the nested shape.
    await data.themes.update("tenantId", created.themeId, {
      fonts: {
        ...baseTheme.fonts,
        title: { bold: false, size: 30 },
      },
    });
    const updated = await data.themes.get("tenantId", created.themeId);
    expect(updated!.fonts).toEqual({
      ...baseTheme.fonts,
      title: { bold: false, size: 30 },
    });
  });
});
