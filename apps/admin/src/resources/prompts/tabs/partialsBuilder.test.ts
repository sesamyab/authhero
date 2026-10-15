import { describe, expect, it } from "vitest";
import {
  BuilderField,
  ensureUlpName,
  errorLocation,
  isValidMapTarget,
  moveField,
  validateFields,
  parseFields,
  serializeFields,
} from "./partialsBuilder";

const firstName: BuilderField = {
  label: "First name",
  name: "first-name",
  type: "text",
  required: true,
  mapTo: "given_name",
};

describe("ensureUlpName", () => {
  it("prefixes and slugifies", () => {
    expect(ensureUlpName("First name")).toBe("ulp-first-name");
  });
  it("is idempotent", () => {
    expect(ensureUlpName(ensureUlpName("Company"))).toBe("ulp-company");
    expect(ensureUlpName("ulp-company")).toBe("ulp-company");
  });
});

describe("isValidMapTarget", () => {
  it("accepts fixed and single-level user_metadata targets", () => {
    expect(isValidMapTarget("given_name")).toBe(true);
    expect(isValidMapTarget("user_metadata.company")).toBe(true);
  });
  it("rejects unknown, nested and prototype targets", () => {
    expect(isValidMapTarget("email")).toBe(false);
    expect(isValidMapTarget("user_metadata.a.b")).toBe(false);
    expect(isValidMapTarget("user_metadata.__proto__")).toBe(false);
    expect(isValidMapTarget("user_metadata.")).toBe(false);
  });
});

describe("serializeFields", () => {
  it("generates a required, mapped text field with a floating label and asterisk", () => {
    expect(serializeFields([firstName])).toBe(
      '<div class="ulp-field"><input type="text" id="ulp-first-name" name="ulp-first-name" required data-authhero-map="given_name" placeholder=" "><label for="ulp-first-name">First name <span class="required" aria-hidden="true">*</span></label></div>',
    );
  });

  it("omits the asterisk when the field is optional", () => {
    expect(serializeFields([{ ...firstName, required: false }])).not.toContain(
      'class="required"',
    );
  });

  it("puts the label above the input when there is a placeholder", () => {
    const html = serializeFields([{ ...firstName, placeholder: "Jane" }]);
    expect(html).toMatch(
      /^<div class="ulp-field"><label[^>]*>.*<\/label><input /,
    );
  });

  it("wraps checkbox inputs in their label", () => {
    const html = serializeFields([
      { label: "Terms", name: "terms", type: "checkbox", required: true },
    ]);
    expect(html).toBe(
      '<div class="ulp-field"><label for="ulp-terms"><input type="checkbox" id="ulp-terms" name="ulp-terms" required> Terms <span class="required" aria-hidden="true">*</span></label></div>',
    );
  });

  it("emits placeholder and maxlength", () => {
    const html = serializeFields([
      { ...firstName, placeholder: "Jane", maxLength: 40, mapTo: "" },
    ]);
    expect(html).toContain('placeholder="Jane"');
    expect(html).toContain('maxlength="40"');
    expect(html).not.toContain("data-authhero-map");
  });

  it("drops invalid map targets", () => {
    expect(serializeFields([{ ...firstName, mapTo: "email" }])).not.toContain(
      "data-authhero-map",
    );
  });

  it("escapes attribute and text content", () => {
    const html = serializeFields([
      { ...firstName, label: 'A <b> & "c"', placeholder: '"x"' },
    ]);
    expect(html).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(html).toContain('placeholder="&quot;x&quot;"');
  });

  it("serializes select options and checkboxes", () => {
    const html = serializeFields([
      {
        label: "Country",
        name: "country",
        type: "select",
        required: false,
        options: ["SE", "NO"],
        mapTo: "user_metadata.country",
      },
      { label: "Terms", name: "terms", type: "checkbox", required: true },
    ]);
    expect(html).toContain(
      '<select id="ulp-country" name="ulp-country" data-authhero-map="user_metadata.country"><option value="SE">SE</option><option value="NO">NO</option></select><label for="ulp-country">Country</label>',
    );
    expect(html).toContain(
      '<input type="checkbox" id="ulp-terms" name="ulp-terms" required> Terms',
    );
  });
});

describe("parseFields", () => {
  it("returns an empty list for empty html", () => {
    expect(parseFields("  ")).toEqual([]);
  });

  it("round-trips builder output", () => {
    const fields: BuilderField[] = [
      {
        ...firstName,
        name: "ulp-first-name",
        placeholder: "Jane",
        maxLength: 40,
      },
      {
        label: "Country",
        name: "ulp-country",
        type: "select",
        required: false,
        options: ["SE", "NO"],
      },
      { label: "Age", name: "ulp-age", type: "number", required: false },
      { label: "Terms", name: "ulp-terms", type: "checkbox", required: true },
    ];
    expect(parseFields(serializeFields(fields))).toEqual(fields);
  });

  it("returns null for imported html that would not round-trip", () => {
    const auth0 =
      '<div class="ulp-field"><label for="ulp-x">X</label><input type="text" name="ulp-x" id="ulp-x" class="input" required></div>';
    expect(parseFields(auth0)).toBeNull();
  });

  it("returns null for unsupported markup", () => {
    expect(parseFields("<p>hello</p>")).toBeNull();
    expect(
      parseFields(
        '<div class="ulp-field"><textarea name="ulp-a"></textarea></div>',
      ),
    ).toBeNull();
    expect(
      parseFields(
        '<div class="ulp-field"><label for="a">A</label><input type="text" id="a" name="a"></div>',
      ),
    ).toBeNull();
  });
});

describe("errorLocation", () => {
  it("finds the insertion point in API messages", () => {
    expect(
      errorLocation(
        'Invalid data-authhero-map target "x" at signup.form-content-end',
      ),
    ).toBe("form-content-end");
    expect(errorLocation("something else")).toBeNull();
  });
});

describe("moveField", () => {
  const f = (name: string): BuilderField => ({
    label: name,
    name,
    type: "text",
    required: false,
  });
  const lists = {
    "form-content-start": [f("a"), f("b"), f("c")],
    "form-content-end": [f("x")],
  };
  const names = (fs?: BuilderField[]) => fs?.map((x) => x.name);

  it("reorders within a list, counting the insert position before the move", () => {
    const moved = moveField(
      lists,
      { point: "form-content-start", index: 0 },
      { point: "form-content-start", index: 3 },
    );
    expect(names(moved?.["form-content-start"])).toEqual(["b", "c", "a"]);

    const up = moveField(
      lists,
      { point: "form-content-start", index: 2 },
      { point: "form-content-start", index: 0 },
    );
    expect(names(up?.["form-content-start"])).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when dropped next to itself", () => {
    for (const index of [1, 2]) {
      expect(
        moveField(
          lists,
          { point: "form-content-start", index: 1 },
          { point: "form-content-start", index },
        ),
      ).toBeNull();
    }
  });

  it("moves between insertion points and returns both lists", () => {
    const moved = moveField(
      lists,
      { point: "form-content-start", index: 1 },
      { point: "form-content-end", index: 0 },
    );
    expect(names(moved?.["form-content-start"])).toEqual(["a", "c"]);
    expect(names(moved?.["form-content-end"])).toEqual(["b", "x"]);
  });

  it("can drop into an empty or missing target at the end", () => {
    const moved = moveField(
      { ...lists, "form-footer-end": [] },
      { point: "form-content-end", index: 0 },
      { point: "form-footer-end", index: 0 },
    );
    expect(names(moved?.["form-content-end"])).toEqual([]);
    expect(names(moved?.["form-footer-end"])).toEqual(["x"]);
  });

  it("returns null for unknown positions", () => {
    expect(
      moveField(
        lists,
        { point: "form-content-start", index: 9 },
        { point: "form-content-end", index: 0 },
      ),
    ).toBeNull();
  });
});

describe("serializeFields select options", () => {
  it("skips blank options", () => {
    const html = serializeFields([
      {
        label: "Country",
        name: "country",
        type: "select",
        required: false,
        options: ["SE", "", "  ", "NO", ""],
      },
    ]);
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

describe("validateFields", () => {
  const ok = (over: Partial<BuilderField> = {}): BuilderField => ({
    label: "First name",
    name: "first-name",
    type: "text",
    required: false,
    ...over,
  });
  const messages = (issues?: { message: string; when: string }[][], i = 0) =>
    issues?.[i].map((x) => `${x.when}:${x.message}`);

  it("accepts a complete field", () => {
    expect(validateFields({ "form-content-end": [ok()] })).toEqual({
      "form-content-end": [[]],
    });
  });

  it("flags an empty label and a missing name only once saving is attempted", () => {
    const r = validateFields({
      "form-content-end": [ok({ label: "" }), ok({ name: "  " })],
    });
    expect(messages(r["form-content-end"], 0)).toEqual([
      "attempt:Label is required",
    ]);
    expect(messages(r["form-content-end"], 1)).toEqual([
      "attempt:Name is required",
    ]);
  });

  it("flags duplicate names across insertion points, whatever the casing or prefix", () => {
    const r = validateFields({
      "form-content-start": [ok({ name: "First name" })],
      "form-content-end": [
        ok({ name: "ulp-first-name" }),
        ok({ name: "other" }),
      ],
    });
    expect(messages(r["form-content-start"], 0)?.[0]).toMatch(
      /^always:.*unique/,
    );
    expect(messages(r["form-content-end"], 0)?.[0]).toMatch(/^always:.*unique/);
    expect(r["form-content-end"]?.[1]).toEqual([]);
  });

  it("does not count unnamed fields as duplicates of each other", () => {
    const r = validateFields({
      "form-content-end": [
        ok({ label: "", name: "" }),
        ok({ label: "", name: "" }),
      ],
    });
    expect(r["form-content-end"]?.every((i) => i.length === 1)).toBe(true);
  });

  it("validates the user_metadata key", () => {
    const r = validateFields({
      "form-content-end": [
        ok({ name: "a", mapTo: "user_metadata." }),
        ok({ name: "b", mapTo: "user_metadata.a b" }),
        ok({ name: "c", mapTo: "user_metadata.company" }),
        ok({ name: "d", mapTo: "given_name" }),
      ],
    });
    expect(messages(r["form-content-end"], 0)).toEqual([
      "attempt:Enter a user_metadata key",
    ]);
    expect(messages(r["form-content-end"], 1)?.[0]).toMatch(/^always:/);
    expect(r["form-content-end"]?.[2]).toEqual([]);
    expect(r["form-content-end"]?.[3]).toEqual([]);
  });

  it("requires at least one non-blank select option", () => {
    const r = validateFields({
      "form-content-end": [
        ok({ type: "select", options: ["", " "] }),
        ok({ name: "b", type: "select", options: ["SE"] }),
      ],
    });
    expect(messages(r["form-content-end"], 0)).toEqual([
      "attempt:Add at least one option",
    ]);
    expect(r["form-content-end"]?.[1]).toEqual([]);
  });
});
