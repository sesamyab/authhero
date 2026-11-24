import { describe, expect, it } from "vitest";
import { transformBranding } from "./transform";

type Themes = {
  colors: Record<string, string>;
  widget?: Record<string, string>;
  colors_dark?: unknown;
};
const themesOf = (o: Record<string, unknown>) => o.themes as Themes;

const fullLight = {
  base_focus_color: "#111111",
  base_hover_color: "#222222",
  body_text: "#000000",
  captcha_widget_theme: "auto",
  error: "#ff0000",
  header: "#000000",
  icons: "#666666",
  input_background: "#ffffff",
  input_border: "#8e8ca0",
  input_filled_text: "#000000",
  input_labels_placeholders: "#88869f",
  links_focused_components: "#7d68f4",
  primary_button: "#7d68f4",
  primary_button_label: "#ffffff",
  secondary_button_border: "#8e8ca0",
  secondary_button_label: "#000000",
  success: "#36bf76",
  widget_background: "#ffffff",
  widget_border: "#8e8ca0",
};

describe("transformBranding clearing", () => {
  it("sends an empty string when a set field is cleared to null", () => {
    const previous = { logo_url: "https://x/logo.png", dark_mode: "auto" };
    const out = transformBranding(
      { logo_url: null, dark_mode: "auto" },
      { previousData: previous },
    );
    expect(out.logo_url).toBe("");
  });

  it("sends a clear when the field is missing from the form data", () => {
    const out = transformBranding(
      { themes: { widget: {} } },
      { previousData: { themes: { widget: { logo_url: "a.png" } } } },
    );
    expect(out).toEqual({ themes: { widget: { logo_url: "" } } });
  });

  it("clears a dark override back to derived", () => {
    const out = transformBranding(
      {
        themes: {
          colors: fullLight,
          colors_dark: { links_focused_components: null },
          widget: { logo_url_dark: undefined },
        },
      },
      {
        previousData: {
          themes: {
            colors: fullLight,
            colors_dark: { links_focused_components: "#aabbcc" },
            widget: { logo_url_dark: "dark.png" },
          },
        },
      },
    );
    const themes = themesOf(out);
    expect(themes.colors_dark).toEqual({ links_focused_components: "" });
    expect(themes.widget?.logo_url_dark).toBe("");
  });

  it("clears a whole sub-object that vanished from the form", () => {
    const out = transformBranding(
      { themes: {} },
      {
        previousData: {
          themes: { colors_dark: { error: "#f00", body_text: "#fff" } },
        },
      },
    );
    expect(out).toEqual({
      themes: { colors_dark: { error: "", body_text: "" } },
    });
  });

  it("does not send nulls for fields that were never set", () => {
    const out = transformBranding(
      { logo_url: null, favicon_url: undefined },
      { previousData: {} },
    );
    expect(out).toEqual({});
  });

  it("leaves enums and numbers alone when cleared", () => {
    const out = transformBranding(
      { dark_mode: null, themes: { borders: { button_border_radius: null } } },
      {
        previousData: {
          dark_mode: "dark",
          themes: { borders: { button_border_radius: 8 } },
        },
      },
    );
    expect(out).toEqual({});
  });

  it("still drops font when it never had a url, keeps a clear when it did", () => {
    expect(
      transformBranding({ font: { url: "" } }, { previousData: {} }).font,
    ).toBeUndefined();
    expect(
      transformBranding(
        { font: { url: null } },
        { previousData: { font: { url: "f.woff2" } } },
      ).font,
    ).toEqual({ url: "" });
  });
});

describe("transformBranding light palette", () => {
  it("fills missing light colours from the core", () => {
    const out = transformBranding({
      themes: {
        colors: {
          primary_button: "#112233",
          widget_background: "#ffffff",
          body_text: "#101010",
        },
      },
    });
    const colors = themesOf(out).colors;
    expect(colors.base_focus_color).toBe("#112233");
    expect(colors.header).toBe("#101010");
    expect(colors.primary_button_label).toBe("#FFFFFF");
    expect(colors.success).toBeTruthy();
  });

  it("replaces a cleared required light colour instead of sending empty", () => {
    const out = transformBranding(
      { themes: { colors: { ...fullLight, icons: null } } },
      { previousData: { themes: { colors: fullLight } } },
    );
    expect(themesOf(out).colors.icons).toBe("#666666");
  });
});
