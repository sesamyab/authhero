import { newSpecPage } from "@stencil/core/testing";
import { AuthheroWidget } from "../src/components/authhero-widget/authhero-widget";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import { screens } from "./fixtures";

const WOFF2 = "https://assets.example.com/fonts/Brand-Regular.woff2";

async function render(fontUrl: string, head = "") {
  const branding = JSON.stringify({ font: { url: fontUrl } });
  const page = await newSpecPage({
    components: [AuthheroWidget, AuthheroNode],
    html: "",
  });
  // What the login page emits server-side goes in <head>, before the widget.
  page.doc.head.innerHTML = head;
  await page.setContent(
    `<authhero-widget screen='${JSON.stringify(screens.login)}' branding='${branding}'></authhero-widget>`,
  );
  await page.waitForChanges();
  return [...page.doc.head.querySelectorAll("[data-authhero-font]")];
}

describe("authhero-widget custom font", () => {
  // A font file loaded as <link rel="stylesheet"> never applies.
  it("registers a font file with @font-face in the document head", async () => {
    const els = await render(WOFF2);
    expect(els).toHaveLength(1);
    expect(els[0]!.tagName).toBe("STYLE");
    expect(els[0]!.textContent).toContain('font-family: "ulp-font"');
    expect(els[0]!.textContent).toContain(`url("${WOFF2}") format("woff2")`);
  });

  it("still loads a stylesheet URL as a link", async () => {
    const css = "https://fonts.example.com/brand.css";
    const els = await render(css);
    expect(els).toHaveLength(1);
    expect(els[0]!.tagName).toBe("LINK");
    expect(els[0]!.getAttribute("href")).toBe(css);
  });

  it("keeps the server-rendered element instead of adding a second", async () => {
    const els = await render(
      WOFF2,
      `<style data-authhero-font="${WOFF2}">/* server */</style>`,
    );
    expect(els).toHaveLength(1);
    expect(els[0]!.textContent).toBe("/* server */");
  });
});
