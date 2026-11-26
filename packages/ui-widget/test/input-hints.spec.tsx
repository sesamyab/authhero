// `h` is the JSX factory Stencil compiles these templates against — used by
// the transform, never referenced by name.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { h } from "@stencil/core";
import { newSpecPage } from "@stencil/core/testing";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import type { FormComponent } from "../src/types/components";

async function input(component: FormComponent) {
  const page = await newSpecPage({
    components: [AuthheroNode],
    template: () => <authhero-node component={component}></authhero-node>,
  });
  await page.waitForChanges();
  const el = page.root!.shadowRoot!.querySelector("input");
  if (!el) throw new Error("No input rendered");
  return el;
}

describe("input hints", () => {
  it("passes input_mode and autocomplete through on a text field", async () => {
    const el = await input({
      id: "code",
      type: "TEXT",
      category: "FIELD",
      config: {
        max_length: 6,
        input_mode: "numeric",
        autocomplete: "one-time-code",
      },
    } as FormComponent);
    expect(el.getAttribute("inputmode")).toBe("numeric");
    expect(el.getAttribute("autocomplete")).toBe("one-time-code");
  });

  it("defaults a password field to current-password", async () => {
    const el = await input({
      id: "password",
      type: "PASSWORD",
      category: "FIELD",
    } as FormComponent);
    expect(el.getAttribute("autocomplete")).toBe("current-password");
  });

  it("uses the configured password autocomplete", async () => {
    const el = await input({
      id: "password",
      type: "PASSWORD",
      category: "FIELD",
      config: { autocomplete: "new-password" },
    } as FormComponent);
    expect(el.getAttribute("autocomplete")).toBe("new-password");
  });
});
