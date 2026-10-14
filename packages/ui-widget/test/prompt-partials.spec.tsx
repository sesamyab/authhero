// `h` is the JSX factory Stencil compiles these templates against.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { h } from "@stencil/core";
import { newSpecPage } from "@stencil/core/testing";
import { AuthheroWidget } from "../src/components/authhero-widget/authhero-widget";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import type { UiScreen } from "../src/types/components";

const screen: UiScreen = {
  name: "signup",
  action: "/u2/screen/signup?state=test",
  method: "POST",
  components: [
    {
      id: "email",
      type: "EMAIL",
      category: "FIELD",
      label: "Email",
      order: 1,
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      config: { text: "Sign up" },
      order: 2,
    },
  ],
  links: [{ id: "login", text: "Log in", href: "/login" }],
  partials: {
    "form-content-start":
      '<div class="ulp-field"><label for="ulp-first-name">First name</label><input id="ulp-first-name" name="ulp-first-name" required></div>',
    "form-content-end": '<span id="content-end">Content end</span>',
    "form-footer-start": '<span id="footer-start">Footer start</span>',
    "form-footer-end": '<span id="footer-end">Footer end</span>',
    "secondary-actions-start":
      '<span id="secondary-start">Secondary start</span>',
    "secondary-actions-end": '<span id="secondary-end">Secondary end</span>',
  },
};

describe("prompt partials", () => {
  it("renders every insertion point inside the form around its target section", async () => {
    const page = await newSpecPage({
      components: [AuthheroWidget, AuthheroNode],
      template: () => <authhero-widget screen={screen}></authhero-widget>,
    });
    await page.waitForChanges();

    const root = page.root!.shadowRoot!;
    const form = root.querySelector("form")!;
    const formContent = form.querySelector(".form-content")!;
    const formFooter = form.querySelector(".form-footer")!;
    const secondaryActions = form.querySelector(".secondary-actions")!;

    expect(form.querySelectorAll(".prompt-partial")).toHaveLength(6);
    expect(
      formContent.firstElementChild?.getAttribute("data-insertion-point"),
    ).toBe("form-content-start");
    expect(
      formFooter.firstElementChild?.getAttribute("data-insertion-point"),
    ).toBe("form-footer-start");
    expect(
      formFooter.lastElementChild?.getAttribute("data-insertion-point"),
    ).toBe("form-footer-end");
    expect(
      secondaryActions.firstElementChild?.getAttribute("data-insertion-point"),
    ).toBe("secondary-actions-start");
    expect(
      secondaryActions.lastElementChild?.getAttribute("data-insertion-point"),
    ).toBe("secondary-actions-end");
    expect(form.querySelector(".links")).not.toBeNull();
    expect(root.querySelector("form > .links")).toBeNull();
  });

  it("runs native validity and includes ulp-* controls in submitted data", async () => {
    const submitted: Array<Record<string, string>> = [];
    const page = await newSpecPage({
      components: [AuthheroWidget, AuthheroNode],
      template: () => (
        <authhero-widget
          screen={screen}
          onFormSubmit={(
            event: CustomEvent<{ data: Record<string, string> }>,
          ) => submitted.push(event.detail.data)}
        ></authhero-widget>
      ),
    });
    await page.waitForChanges();

    const form = page.root!.shadowRoot!.querySelector("form")!;
    const firstName = form.querySelector<HTMLInputElement>(
      'input[name="ulp-first-name"]',
    )!;
    firstName.value = "Ada";

    const originalFormData = global.FormData;
    (global as unknown as { FormData: typeof FormData }).FormData = class {
      constructor(private readonly source: HTMLFormElement) {}

      forEach(callback: (value: string, key: string) => void) {
        this.source
          .querySelectorAll<HTMLInputElement>("input[name]")
          .forEach((input) => callback(input.value, input.name));
      }
    } as unknown as typeof FormData;

    try {
      form.reportValidity = jest.fn(() => true);
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await page.waitForChanges();

      expect(form.reportValidity).toHaveBeenCalled();
      expect(submitted).toEqual([{ "ulp-first-name": "Ada" }]);

      submitted.length = 0;
      form.reportValidity = jest.fn(() => false);
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await page.waitForChanges();

      expect(submitted).toHaveLength(0);
    } finally {
      (global as unknown as { FormData: typeof FormData }).FormData =
        originalFormData;
    }
  });
});
