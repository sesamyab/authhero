/**
 * The u2 page warns users who are inside an in-app browser (Instagram,
 * Facebook, WebViews, ...), which tends to drop sessions. The classic /u
 * identifier page had this warning; u2 lost it.
 */
import { describe, expect, it } from "vitest";
import { renderWidgetPageResponse } from "../../src/routes/universal-login/u2-widget-page";
import { buildPreviewScreen } from "../../src/routes/management-api/branding-preview";

const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0";
const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

const SAMSUNG_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36";

async function render(userAgent: string, language?: string) {
  const screen = buildPreviewScreen("login");
  const ctx = {
    html: (doc: unknown) => doc,
    req: {
      header: (name: string) =>
        name.toLowerCase() === "user-agent" ? userAgent : undefined,
      raw: { headers: new Headers() },
    },
    env: {},
    var: {},
  };
  const rendered: unknown = await renderWidgetPageResponse(ctx as never, {
    screenId: screen.name,
    screenJson: JSON.stringify(screen),
    state: "preview",
    authParamsJson: JSON.stringify({ client_id: "preview" }),
    branding: undefined,
    theme: undefined,
    clientName: "Acme Inc",
    language,
  });
  return String(rendered);
}

describe("u2 page — embedded browser warning", () => {
  it("shows the banner with the browser name for an in-app browser", async () => {
    const html = await render(INSTAGRAM_UA);
    expect(html).toContain('class="ah-embedded-warning"');
    expect(html).toContain("Do you have to keep logging in?");
    expect(html).toContain("You are currently inside the Instagram.");
  });

  it("treats standalone Samsung Internet as a regular browser", async () => {
    const html = await render(SAMSUNG_UA);
    expect(html).not.toContain('<div class="ah-embedded-warning"');
    expect(html).toContain("ah-private-warning");
  });

  it("localizes the banner", async () => {
    const html = await render(INSTAGRAM_UA, "sv");
    expect(html).toContain("Måste du logga in hela tiden?");
  });

  it("omits the embedded banner for a regular browser", async () => {
    const html = await render(SAFARI_UA);
    expect(html).not.toContain('<div class="ah-embedded-warning"');
  });

  it("ships a hidden private-browsing banner and the detection bundle for regular browsers", async () => {
    const html = await render(SAFARI_UA);
    expect(html).toContain("ah-private-warning");
    expect(html).toContain("Private browsing detected");
    expect(html).toContain("/u/js/client.js");
  });

  it("skips the private probe when the embedded banner already shows", async () => {
    const html = await render(INSTAGRAM_UA);
    expect(html).not.toContain('ah-private-warning"');
  });
});
