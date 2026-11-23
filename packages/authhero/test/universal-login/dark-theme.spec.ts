/**
 * Dark scheme of the u2 login page (#1740).
 *
 * Fallback order for every dark value: explicit tenant dark field, then the
 * derived dark value, then the light value. A tenant with no dark fields must
 * render the same dark palette as before (apart from keeping its brand link
 * colour, which used to fall back to a stock blue).
 */
import { describe, expect, it } from "vitest";
import {
  themeInsertSchema,
  colorsDarkSchema,
} from "@authhero/adapter-interfaces";
import { renderWidgetPageResponse } from "../../src/routes/universal-login/u2-widget-page";
import {
  resolveDarkPageInputs,
  sanitizeColorsDark,
} from "../../src/routes/universal-login/dark-theme";
import { buildPreviewScreen } from "../../src/routes/management-api/branding-preview";
import { DEFAULT_THEME } from "../../src/constants/defaultTheme";

const branding = {
  logo_url: "https://example.com/branding-logo.png",
  colors: { primary: "#6366f1" },
};

async function render(theme: Record<string, unknown>) {
  const screen = buildPreviewScreen("login");
  const ctx = {
    html: (doc: unknown) => doc,
    req: { header: () => undefined, raw: { headers: new Headers() } },
    env: {},
    var: {},
  };
  const rendered: unknown = await renderWidgetPageResponse(ctx as never, {
    screenId: screen.name,
    screenJson: JSON.stringify(screen),
    brandingJson: JSON.stringify(branding),
    themeJson: JSON.stringify(theme),
    state: "preview",
    authParamsJson: JSON.stringify({ client_id: "preview" }),
    branding: branding as never,
    theme: theme as never,
    clientName: "Acme Inc",
  });
  return typeof rendered === "string" ? rendered : String(rendered);
}

/** The page stylesheet, not the widget's inlined shadow CSS. */
function pageCss(html: string): string {
  const start = html.indexOf("<style>");
  return html.slice(start, html.indexOf("</style>", start));
}

/** The prefers-dark variable block for the widget. */
function darkVarBlock(css: string): string {
  const m = css.match(
    /html:not\(\.ah-light-mode\) authhero-widget \{([^}]*)\}/,
  );
  return m?.[1] ?? "";
}

const light = {
  ...DEFAULT_THEME,
  colors: {
    ...DEFAULT_THEME.colors,
    links_focused_components: "#7D68F4",
    widget_background: "#ffffff",
  },
};

describe("dark scheme fallback chain", () => {
  it("derived: tenant without dark fields keeps the derived palette", async () => {
    const block = darkVarBlock(pageCss(await render(light)));
    expect(block).toContain("--ah-color-bg: #1f2937 !important");
    expect(block).toContain("--ah-color-text: #f9fafb !important");
  });

  it("derived: keeps the brand link colour instead of stock blue", async () => {
    const block = darkVarBlock(pageCss(await render(light)));
    // Brand purple, lightened just enough to read on the dark card.
    expect(block).not.toContain("#60a5fa");
    const m = block.match(/--ah-color-link: (#[0-9a-f]{6}) !important/i);
    expect(m).not.toBeNull();
    expect(m![1]!.toLowerCase()).toBe("#9786f6");
  });

  it("derived: lightens a brand link colour that is too dark for dark", async () => {
    const theme = {
      ...light,
      colors: { ...light.colors, links_focused_components: "#1a1a80" },
    };
    const block = darkVarBlock(pageCss(await render(theme)));
    const m = block.match(/--ah-color-link: (#[0-9a-f]{6}) !important/i);
    expect(m).not.toBeNull();
    expect(m![1]!.toLowerCase()).not.toBe("#1a1a80");
  });

  it("light fallback: no link colour in the theme keeps the stock dark link", async () => {
    const theme = {
      ...light,
      colors: { ...light.colors, links_focused_components: "" },
    };
    const block = darkVarBlock(pageCss(await render(theme)));
    expect(block).toContain("--ah-color-link: #60a5fa !important");
  });

  it("explicit: colors_dark wins over derived and brand", async () => {
    const theme = {
      ...light,
      colors_dark: {
        widget_background: "#101827",
        links_focused_components: "#ff8800",
        primary_button: "#22d3ee",
      },
    };
    const block = darkVarBlock(pageCss(await render(theme)));
    expect(block).toContain("--ah-color-bg: #101827 !important");
    expect(block).toContain("--ah-color-link: #ff8800 !important");
    expect(block).toContain("--ah-color-primary: #22d3ee !important");
    // Keys that were not overridden still derive.
    expect(block).toContain("--ah-color-text: #f9fafb !important");
    // The explicit primary gets a readable label.
    expect(block).toContain("--ah-color-text-on-primary: #000000 !important");
  });

  it("explicit values are sanitized before they reach the stylesheet", async () => {
    const theme = {
      ...light,
      colors_dark: {
        widget_background: "red; } body { display: none",
        error: "rgb(0,0,0); } *{display:none} x{y:rgb(1,1,1)",
        body_text: "#ffffff",
      },
    };
    const css = pageCss(await render(theme));
    expect(css).not.toContain("body { display: none");
    expect(css).not.toContain("*{display:none}");
    expect(darkVarBlock(css)).not.toContain("--ah-color-bg: red");
    expect(darkVarBlock(css)).toContain("--ah-color-text: #ffffff !important");
  });
});

describe("dark page background", () => {
  it("emits no dark body rule when the tenant set none (same as light)", async () => {
    expect(pageCss(await render(light))).not.toContain(
      "html:not(.ah-light-mode) body { background",
    );
  });

  it("uses the explicit dark colour and image under both dark selectors", async () => {
    const css = pageCss(
      await render({
        ...light,
        page_background: {
          ...light.page_background,
          background_color_dark: "#0b0f19",
          background_image_url_dark: "https://example.com/bg-dark.jpg",
        },
      }),
    );
    const bg = `#0b0f19 url("https://example.com/bg-dark.jpg") center / cover no-repeat`;
    expect(css).toContain(`html.ah-dark-mode body { background: ${bg}; }`);
    expect(css).toContain(
      `html:not(.ah-light-mode) body { background: ${bg}; }`,
    );
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  it("falls back to the light image under an explicit dark colour", async () => {
    const css = pageCss(
      await render({
        ...light,
        page_background: {
          ...light.page_background,
          background_image_url: "https://example.com/bg.jpg",
          background_color_dark: "#0b0f19",
        },
      }),
    );
    expect(css).toContain(
      `html.ah-dark-mode body { background: #0b0f19 url("https://example.com/bg.jpg") center / cover no-repeat; }`,
    );
  });
});

describe("logo", () => {
  it("renders a single widget logo and no swap CSS without a dark logo", async () => {
    const html = await render(light);
    expect(html).not.toContain('class="logo logo-dark"');
    expect(html).not.toContain('ah-logo-img--dark"');
    expect(pageCss(html)).not.toContain("--ah-logo-dark-display");
  });

  it("renders both variants in the widget and swaps them via server CSS", async () => {
    const html = await render({
      ...light,
      widget: {
        ...light.widget,
        logo_url: "https://example.com/logo.png",
        logo_url_dark: "https://example.com/logo-dark.png",
      },
    });
    expect(html).toContain("logo logo-light");
    expect(html).toContain("https://example.com/logo-dark.png");
    const css = pageCss(html);
    expect(css).toContain(
      "html.ah-dark-mode authhero-widget { --ah-logo-light-display: none; --ah-logo-dark-display: block; }",
    );
    expect(css).toContain(
      "html:not(.ah-light-mode) authhero-widget { --ah-logo-light-display: none; --ah-logo-dark-display: block; }",
    );
    // The page's logo chip gets both images too.
    expect(html).toContain('class="ah-logo-img ah-logo-img--dark"');
  });

  it("theme logo wins over branding logo", () => {
    const inputs = resolveDarkPageInputs(
      { widget: { logo_url: "https://example.com/theme.png" } },
      { logo_url: "https://example.com/branding.png" },
    );
    expect(inputs.logoUrl).toBe("https://example.com/theme.png");
    const fallback = resolveDarkPageInputs(
      { widget: {} },
      { logo_url: "https://example.com/branding.png" },
    );
    expect(fallback.logoUrl).toBe("https://example.com/branding.png");
  });

  it("ignores a dark logo when there is no light logo", () => {
    const inputs = resolveDarkPageInputs(
      { widget: { logo_url_dark: "https://example.com/dark.png" } },
      undefined,
    );
    expect(inputs.hasDarkLogo).toBe(false);
  });
});

describe("color-scheme and social icons", () => {
  it("sets color-scheme for auto, dark and light", async () => {
    const css = pageCss(await render(light));
    expect(css).toContain("html { color-scheme: light dark; }");
    expect(css).toContain("html.ah-dark-mode { color-scheme: dark; }");
    expect(css).toContain("html.ah-light-mode { color-scheme: light; }");
  });

  it("inverts black provider icons in dark", async () => {
    const css = pageCss(await render(light));
    expect(css).toContain(
      "html.ah-dark-mode authhero-widget::part(social-icon-apple)",
    );
    expect(css).toMatch(/social-icon-github\) \{ filter: invert\(1\); \}/);
  });
});

describe("review fixes", () => {
  it("escapes logo URLs once (light and dark)", async () => {
    const html = await render({
      ...light,
      widget: {
        ...light.widget,
        logo_url: "https://example.com/l.svg?size=2&sig=abc",
        logo_url_dark: "https://example.com/d.svg?size=2&sig=def",
      },
    });
    expect(html).toContain("l.svg?size=2&amp;sig=abc");
    expect(html).toContain("d.svg?size=2&amp;sig=def");
    expect(html).not.toContain("&amp;amp;");
  });

  it("floats the widget when only a dark background image is set", async () => {
    const html = await render({
      ...light,
      page_background: {
        ...light.page_background,
        background_image_url: "",
        background_image_url_dark: "https://example.com/bg-dark.jpg",
      },
    });
    expect(html).toMatch(/<authhero-widget[^>]*\sfloating/);
    const plain = await render(light);
    expect(plain).not.toMatch(/<authhero-widget[^>]*\sfloating/);
  });

  it("darkens a pale link when the dark card is light", async () => {
    const block = darkVarBlock(
      pageCss(
        await render({
          ...light,
          colors: { ...light.colors, links_focused_components: "#eeeeee" },
          colors_dark: { widget_background: "#ffffff" },
        }),
      ),
    );
    const m = block.match(/--ah-color-link: (#[0-9a-f]{6}) !important/i);
    expect(m).not.toBeNull();
    expect(m![1]!.toLowerCase()).not.toBe("#ffffff");
    expect(m![1]!.toLowerCase()).not.toBe("#eeeeee");
  });

  it("does not invert black icons on a light card in dark", async () => {
    const css = pageCss(
      await render({ ...light, colors_dark: { widget_background: "#ffffff" } }),
    );
    expect(css).not.toContain("social-icon-apple");
  });

  it("derives the dark primary from the theme before branding, like the runtime", async () => {
    // branding primary #6366f1 is readable on the dark card; the theme's
    // #101010 is not and must be lightened in the stylesheet as well.
    const block = darkVarBlock(
      pageCss(
        await render({
          ...light,
          colors: { ...light.colors, primary_button: "#101010" },
        }),
      ),
    );
    expect(block).toContain("--ah-color-primary:");
  });

  it.each([
    ["black", "#ffffff"],
    ["white", "#000000"],
    ["rgb(0, 0, 0)", "#ffffff"],
    ["hsl(0, 0%, 100%)", "#000000"],
  ])(
    "derives the button label from explicit primary %s",
    async (color, label) => {
      const block = darkVarBlock(
        pageCss(
          await render({ ...light, colors_dark: { primary_button: color } }),
        ),
      );
      expect(block).toContain(
        `--ah-color-text-on-primary: ${label} !important`,
      );
    },
  );

  it.each([
    // percentages with stray whitespace are still percentages: white button
    ["rgb( 100%, 100%, 100%)", "#000000"],
    // zero alpha shows the (dark) card, not the underlying colour
    ["rgba(255,255,255,0)", "#ffffff"],
    ["#ffffff00", "#ffffff"],
    ["hsla(0, 0%, 100%, 0)", "#ffffff"],
    ["transparent", "#ffffff"],
    // angle units: 0.5turn = 180deg = cyan, light enough for black text
    ["hsl(0.5turn, 100%, 50%)", "#000000"],
    ["hsl(200grad, 100%, 50%)", "#000000"],
    ["hsl(3.14159rad, 100%, 50%)", "#000000"],
    // negative saturation clamps to 0: grey #666666 -> white text
    ["hsl(240, -100%, 40%)", "#ffffff"],
    // unitless hue is degrees: 0 = red, white text
    ["hsl(0, 100%, 40%)", "#ffffff"],
  ])("derives the label for %s as %s", async (color, label) => {
    const block = darkVarBlock(
      pageCss(
        await render({ ...light, colors_dark: { primary_button: color } }),
      ),
    );
    expect(block).toContain(`--ah-color-text-on-primary: ${label} !important`);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "does not throw on the inherited name %s as a colour",
    async (name) => {
      const theme = {
        ...light,
        colors: { ...light.colors, links_focused_components: name },
        colors_dark: { links_focused_components: name, primary_button: name },
      };
      await expect(render(theme)).resolves.toContain("authhero-widget");
    },
  );

  it("an explicit label wins over the derived one", async () => {
    const block = darkVarBlock(
      pageCss(
        await render({
          ...light,
          colors_dark: {
            primary_button: "black",
            primary_button_label: "#abcdef",
          },
        }),
      ),
    );
    expect(block).toContain("--ah-color-text-on-primary: #abcdef !important");
  });

  it("ignores an explicit primary it cannot resolve, keeping colour and label together", async () => {
    const block = darkVarBlock(
      pageCss(
        await render({
          ...light,
          colors_dark: { primary_button: "papayawhip" },
        }),
      ),
    );
    expect(block).not.toContain("papayawhip");
    // The derived primary (the theme's #7D68F4) keeps its derived label.
    expect(block).toContain("--ah-color-text-on-primary: #ffffff !important");
  });

  it("applies an unresolvable primary as written when the tenant also set a label", async () => {
    const block = darkVarBlock(
      pageCss(
        await render({
          ...light,
          colors_dark: {
            primary_button: "papayawhip",
            primary_button_label: "#111111",
          },
        }),
      ),
    );
    expect(block).toContain("--ah-color-primary: papayawhip !important");
    expect(block).toContain("--ah-color-text-on-primary: #111111 !important");
  });
});

describe("sanitizeColorsDark", () => {
  it("drops unsafe values and returns undefined when nothing is left", () => {
    expect(sanitizeColorsDark({ error: "red;}" })).toBeUndefined();
    expect(sanitizeColorsDark(undefined)).toBeUndefined();
    expect(sanitizeColorsDark({ error: "#fff", header: "x{" })).toEqual({
      error: "#fff",
    });
  });
});

describe("theme schema", () => {
  it("still validates a payload without any dark field (Auth0 shape)", () => {
    expect(themeInsertSchema.safeParse(DEFAULT_THEME).success).toBe(true);
  });

  it("accepts the optional dark fields", () => {
    const parsed = themeInsertSchema.parse({
      ...DEFAULT_THEME,
      colors_dark: {
        widget_background: "#000",
        links_focused_components: "#f80",
      },
      page_background: {
        ...DEFAULT_THEME.page_background,
        background_color_dark: "#000",
        background_image_url_dark: "https://example.com/d.jpg",
      },
      widget: {
        ...DEFAULT_THEME.widget,
        logo_url_dark: "https://example.com/d.png",
      },
    });
    expect(parsed.colors_dark?.widget_background).toBe("#000");
    expect(parsed.widget.logo_url_dark).toBe("https://example.com/d.png");
    expect(parsed.page_background.background_color_dark).toBe("#000");
  });

  it("rejects non-string dark values and unknown keys are not accepted as colours", () => {
    expect(
      themeInsertSchema.safeParse({
        ...DEFAULT_THEME,
        colors_dark: { error: 1 },
      }).success,
    ).toBe(false);
    // captcha_widget_theme is a scheme setting and has no dark override.
    expect(colorsDarkSchema.shape).not.toHaveProperty("captcha_widget_theme");
  });
});
