/**
 * Terms and privacy links on the u2 login page (#1735).
 *
 * Per-client `tos_uri` / `policy_uri` win, the legacy single
 * `termsAndConditionsUrl` stays as the terms fallback, and the tenant's
 * branding `terms_url` / `privacy_url` fill whatever the client left unset.
 */
import { describe, expect, it } from "vitest";
import {
  clientLegalUrls,
  withTenantLegalDefaults,
} from "../../src/routes/universal-login/legal-links";
import { renderWidgetPageResponse } from "../../src/routes/universal-login/u2-widget-page";
import { buildPreviewScreen } from "../../src/routes/management-api/branding-preview";

describe("clientLegalUrls", () => {
  it("returns nothing for a client without links", () => {
    expect(clientLegalUrls(undefined)).toEqual({
      termsAndConditionsUrl: undefined,
      privacyUrl: undefined,
    });
  });

  it("keeps the legacy termsAndConditionsUrl as terms", () => {
    expect(
      clientLegalUrls({ termsAndConditionsUrl: "https://e.com/legacy" }),
    ).toEqual({
      termsAndConditionsUrl: "https://e.com/legacy",
      privacyUrl: undefined,
    });
  });

  it("prefers tos_uri over the legacy key and reads policy_uri", () => {
    expect(
      clientLegalUrls({
        tos_uri: "https://e.com/tos",
        termsAndConditionsUrl: "https://e.com/legacy",
        policy_uri: "https://e.com/privacy",
      }),
    ).toEqual({
      termsAndConditionsUrl: "https://e.com/tos",
      privacyUrl: "https://e.com/privacy",
    });
  });

  it("drops unsafe URLs", () => {
    expect(
      clientLegalUrls({ tos_uri: "javascript:alert(1)", policy_uri: "x" }),
    ).toEqual({ termsAndConditionsUrl: undefined, privacyUrl: undefined });
  });

  it("rejects data: URLs so the next source is used", () => {
    const legal = clientLegalUrls({
      tos_uri: "data:text/html,<p>terms</p>",
      termsAndConditionsUrl: "https://e.com/legacy",
      policy_uri: "data:text/html,<p>privacy</p>",
    });
    expect(legal).toEqual({
      termsAndConditionsUrl: "https://e.com/legacy",
      privacyUrl: undefined,
    });
    expect(
      withTenantLegalDefaults(legal, { privacy_url: "https://t.com/privacy" })
        .privacyUrl,
    ).toBe("https://t.com/privacy");
  });

  it("keeps relative paths and returns URLs unescaped", () => {
    expect(
      clientLegalUrls({
        tos_uri: "/terms",
        policy_uri: "https://e.com/privacy?lang=en&region=us",
      }),
    ).toEqual({
      termsAndConditionsUrl: "/terms",
      privacyUrl: "https://e.com/privacy?lang=en&region=us",
    });
  });
});

describe("withTenantLegalDefaults", () => {
  const branding = {
    terms_url: "https://t.com/terms",
    privacy_url: "https://t.com/privacy",
  };

  it("fills gaps from the tenant", () => {
    expect(withTenantLegalDefaults({}, branding)).toEqual({
      termsAndConditionsUrl: "https://t.com/terms",
      privacyUrl: "https://t.com/privacy",
    });
  });

  it("lets the client win per field", () => {
    expect(
      withTenantLegalDefaults(
        { privacyUrl: "https://c.com/privacy" },
        branding,
      ),
    ).toEqual({
      termsAndConditionsUrl: "https://t.com/terms",
      privacyUrl: "https://c.com/privacy",
    });
  });

  it("is a no-op without branding defaults", () => {
    expect(
      withTenantLegalDefaults(
        { termsAndConditionsUrl: "https://c.com/t" },
        null,
      ),
    ).toEqual({
      termsAndConditionsUrl: "https://c.com/t",
      privacyUrl: undefined,
    });
  });
});

async function render(
  opts: { termsAndConditionsUrl?: string; privacyUrl?: string },
  branding: Record<string, unknown> = {},
) {
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
    themeJson: JSON.stringify({}),
    state: "preview",
    authParamsJson: JSON.stringify({ client_id: "preview" }),
    branding: branding as never,
    theme: {} as never,
    clientName: "Acme Inc",
    ...opts,
  });
  return typeof rendered === "string" ? rendered : String(rendered);
}

function legalChip(html: string) {
  const start = html.indexOf('<div class="ah-chip-legal');
  return html.slice(start, html.indexOf("</div>", start));
}

describe("u2 page legal links", () => {
  it("renders one link, as before, for a legacy terms URL", async () => {
    const chip = legalChip(
      await render({ termsAndConditionsUrl: "https://e.com/terms" }),
    );
    expect(chip.match(/<a /g)).toHaveLength(1);
    expect(chip).toContain("https://e.com/terms");
  });

  it("renders separate terms and privacy links", async () => {
    const chip = legalChip(
      await render({
        termsAndConditionsUrl: "https://e.com/terms",
        privacyUrl: "https://e.com/privacy",
      }),
    );
    expect(chip.match(/<a /g)).toHaveLength(2);
    expect(chip).toContain('href="https://e.com/terms"');
    expect(chip).toContain('href="https://e.com/privacy"');
    expect(chip).toContain("Privacy Policy");
  });

  it("falls back to the tenant defaults", async () => {
    const html = await render(
      {},
      {
        terms_url: "https://t.com/terms",
        privacy_url: "https://t.com/privacy",
      },
    );
    const chip = legalChip(html);
    expect(chip).toContain("https://t.com/terms");
    expect(chip).toContain("https://t.com/privacy");
    // Phone footer carries them too.
    const footer = html.slice(html.indexOf('<footer class="ah-footer"'));
    expect(footer).toContain("https://t.com/privacy");
  });

  it("escapes a query string exactly once in the rendered link", async () => {
    const html = await render(
      {},
      { privacy_url: "https://t.com/privacy?lang=en&region=us" },
    );
    const chip = legalChip(html);
    expect(chip).toContain(
      'href="https://t.com/privacy?lang=en&amp;region=us"',
    );
    expect(chip).not.toContain("&amp;amp;");
  });

  it("emits no legal chip when nothing is configured", async () => {
    expect(await render({})).not.toContain('<div class="ah-chip-legal');
  });
});
