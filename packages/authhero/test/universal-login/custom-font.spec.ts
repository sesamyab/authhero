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

async function toHtml(rendered: unknown): Promise<string> {
  if (typeof rendered === "string") return rendered;
  const out: unknown = String(rendered);
  return typeof out === "string" ? out : String(await out);
}

async function renderPage(fontUrl: string) {
  const screen = buildPreviewScreen("login");
  const branding = { font: { url: fontUrl } };
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
    themeJson: JSON.stringify({}),
    state: "preview",
    authParamsJson: JSON.stringify({ client_id: "preview" }),
    branding: branding as never,
    theme: {} as never,
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
    expect(html).toMatch(/font-family:\s*"ulp-font"/);
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
});
