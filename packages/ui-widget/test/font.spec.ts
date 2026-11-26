import {
  buildFontFaceCss,
  fontFileFormat,
  renderFontHead,
  resolveFontHead,
} from "../src/page-chrome/font";

const WOFF2 = "https://assets.example.com/fonts/Brand-Regular.woff2";

describe("custom font URL", () => {
  it("recognises font files by extension, ignoring query and case", () => {
    expect(fontFileFormat(WOFF2)).toBe("woff2");
    expect(fontFileFormat("https://cdn.example.com/a.WOFF?v=3#x")).toBe("woff");
    expect(fontFileFormat("/fonts/brand.ttf")).toBe("truetype");
    expect(fontFileFormat("https://cdn.example.com/brand.otf")).toBe(
      "opentype",
    );
    expect(fontFileFormat("data:font/woff2;base64,AAAA")).toBe("woff2");
  });

  it("treats anything else as a stylesheet", () => {
    expect(
      fontFileFormat(
        "https://fonts.googleapis.com/css2?family=Inter&display=swap",
      ),
    ).toBeUndefined();
    expect(fontFileFormat("https://cdn.example.com/fonts.css")).toBeUndefined();
    expect(fontFileFormat(undefined)).toBeUndefined();
  });

  // The bug: a font file was emitted as <link rel="stylesheet">, which the
  // browser downloads and discards, so the font never applied.
  it("registers a font file as the ulp-font family", () => {
    expect(buildFontFaceCss(WOFF2)).toBe(
      `@font-face { font-family: "ulp-font"; src: url("${WOFF2}") format("woff2"); font-display: swap; }`,
    );
    const html = renderFontHead(WOFF2);
    expect(html).toMatch(/^<style data-authhero-font="[^"]+">@font-face/);
    expect(html).not.toContain("<link");
  });

  it("keeps a stylesheet URL as a link, escaped once", () => {
    const css = "https://fonts.googleapis.com/css2?family=Inter&display=swap";
    expect(renderFontHead(css)).toBe(
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap" data-authhero-font="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap">`,
    );
  });

  it("cannot break out of the style element or the url()", () => {
    const hostile =
      'https://x.example/a.woff2?q=")}</style><script>alert(1)</script>';
    const html = renderFontHead(hostile);
    expect(html).not.toContain("</style><script>");
    expect(html).not.toContain('")}');
  });

  it("drops unsafe schemes", () => {
    expect(resolveFontHead("javascript:alert(1)//x.woff2")).toBeUndefined();
    expect(renderFontHead("javascript:alert(1)")).toBe("");
  });
});
