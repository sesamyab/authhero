/**
 * The tenant's custom font (`branding.font.url`) on the u2 pages.
 *
 * The URL normally points at a font file, as in Auth0. It used to be emitted
 * as `<link rel="stylesheet">`, which the browser downloads and discards, so
 * the font never applied. A font file is now declared with `@font-face` for
 * the `ulp-font` family the widget stylesheet lists first.
 */
import { describe, expect, it } from "vitest";
import { renderWidgetPageResponse } from "../../src/routes/universal-login/u2-widget-page";
import { buildPreviewScreen } from "../../src/routes/management-api/branding-preview";
import { ErrorPage } from "../../src/routes/universal-login/error-page";

const WOFF2 = "https://assets.example.com/fonts/Brand-Regular.woff2";
const GOOGLE_CSS =
  "https://fonts.googleapis.com/css2?family=Inter&display=swap";

// The `body` rule's font stack, not the `@font-face` declaration, which also
// names "ulp-font" and would match even if the page fell back to system fonts.
const BODY_USES_CUSTOM_FONT = /\bbody\s*\{[^}]*font-family:\s*"ulp-font"/;

async function toHtml(rendered: unknown): Promise<string> {
  if (typeof rendered === "string") return rendered;
  const out: unknown = String(rendered);
  return typeof out === "string" ? out : String(await out);
}

async function renderPage(
  fontUrl: string,
  where: "branding" | "theme" = "branding",
) {
  const screen = buildPreviewScreen("login");
  const branding = where === "branding" ? { font: { url: fontUrl } } : {};
  const theme = where === "theme" ? { fonts: { font_url: fontUrl } } : {};
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
  return toHtml(rendered);
}

describe("custom font on u2 pages", () => {
  it("declares a font file with @font-face instead of a stylesheet link", async () => {
    const html = await renderPage(WOFF2);
    expect(html).toContain(
      `@font-face { font-family: "ulp-font"; src: url("${WOFF2}") format("woff2");`,
    );
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"[^>]*\.woff2/);
    expect(html).toMatch(BODY_USES_CUSTOM_FONT);
  });

  it("keeps a stylesheet URL as a link, with the query escaped once", async () => {
    const html = await renderPage(GOOGLE_CSS);
    expect(html).toContain(
      'href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap"',
    );
    expect(html).not.toContain("&amp;amp;");
  });

  it("declares a font file on the error page too", async () => {
    const html = await toHtml(
      ErrorPage({
        message: "Something went wrong",
        statusCode: 400,
        branding: { font: { url: WOFF2 } },
      }),
    );
    expect(html).toContain(`src: url("${WOFF2}") format("woff2")`);
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"[^>]*\.woff2/);
  });

  // The widget resolves theme.fonts.font_url before branding.font.url; the
  // server-rendered pages must too, or a theme-only font never reaches them.
  it("uses the theme font when no branding font is set", async () => {
    const html = await renderPage(WOFF2, "theme");
    expect(html).toContain(`src: url("${WOFF2}") format("woff2")`);
    expect(html).toMatch(BODY_USES_CUSTOM_FONT);
  });

  it("uses the theme font on the error page", async () => {
    const html = await toHtml(
      ErrorPage({
        message: "Something went wrong",
        statusCode: 400,
        theme: { fonts: { font_url: WOFF2 } } as never,
      }),
    );
    expect(html).toContain(`src: url("${WOFF2}") format("woff2")`);
    expect(html).toMatch(BODY_USES_CUSTOM_FONT);
  });
});
