import { describe, expect, it } from "vitest";
import {
  completeLightColors,
  contrastRatio,
  contrastWarnings,
  deriveDependentColors,
  generateDarkFromLight,
  isValidColor,
  validateColor,
  DEFAULT_LIGHT_COLORS,
} from "./theme-colors";

describe("validation", () => {
  it("accepts hex and functional colours, rejects junk", () => {
    for (const v of [
      "#fff",
      "#7D68F4",
      "#7D68F4cc",
      "rgb(1, 2, 3)",
      "hsl(10 20% 30%)",
    ])
      expect(isValidColor(v)).toBe(true);
    for (const v of ["#12", "#ggg", "not a colour", "rgb(", "url(x)"])
      expect(isValidColor(v)).toBe(false);
  });
  it("only reports a message for non-empty invalid input", () => {
    expect(validateColor("")).toBeUndefined();
    expect(validateColor("#7D68F4")).toBeUndefined();
    expect(validateColor("purple-ish")).toMatch(/valid colour/);
  });
});

describe("contrast", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(contrastRatio("rgb(0,0,0)", "#fff")).toBeNull();
  });
  it("warns on low contrast pairs and skips non-hex", () => {
    const w = contrastWarnings({
      ...DEFAULT_LIGHT_COLORS,
      body_text: "#eeeeee",
      links_focused_components: "rgb(1,2,3)",
    });
    expect(w.map((x) => x.label)).toContain("Body text on widget background");
    expect(w.map((x) => x.label)).not.toContain("Links on widget background");
  });
  it("flags the shipped default palette where it misses AA", () => {
    // Real: #7D68F4 links, #FC5A5A errors and #88869F placeholders on white.
    expect(contrastWarnings(DEFAULT_LIGHT_COLORS).map((w) => w.label)).toEqual([
      "Links on widget background",
      "Error text on widget background",
      "Input labels/placeholders on input background",
    ]);
  });
});

describe("derivation", () => {
  it("derives dependents from the core", () => {
    const d = deriveDependentColors({
      primary_button: "#101010",
      body_text: "#222222",
    });
    expect(d.base_focus_color).toBe("#101010");
    expect(d.header).toBe("#222222");
    expect(d.primary_button_label).toBe("#FFFFFF");
  });
  it("completes a partial palette without overwriting set values", () => {
    const out = completeLightColors({
      primary_button: "#112233",
      icons: "#abcdef",
    });
    expect(out.icons).toBe("#abcdef");
    expect(Object.values(out).every(Boolean)).toBe(true);
    expect(Object.keys(out)).toHaveLength(18);
  });
  it("generates a readable dark palette that keeps the brand colours", () => {
    const dark = generateDarkFromLight({
      ...DEFAULT_LIGHT_COLORS,
      links_focused_components: "#0000ee",
    });
    expect(dark.widget_background).toBe("#1F2937");
    expect(dark.primary_button).toBe(DEFAULT_LIGHT_COLORS.primary_button);
    expect(
      contrastRatio(dark.links_focused_components!, dark.widget_background!)!,
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastWarnings(dark)).toEqual([]);
  });
});
