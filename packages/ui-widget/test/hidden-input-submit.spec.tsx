import { newSpecPage, SpecPage } from "@stencil/core/testing";
import { AuthheroWidget } from "../src/components/authhero-widget/authhero-widget";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import type { UiScreen } from "../src/types/components";

const screen: UiScreen = {
  name: "login",
  action: "/u2/screen/login?state=abc",
  method: "POST",
  components: [
    {
      id: "fingerprint",
      type: "TEXT",
      category: "FIELD",
      visible: false,
      order: 0,
      config: { default_value: "initial" },
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      visible: true,
      order: 1,
      config: { text: "Continue" },
    },
  ],
} as UiScreen;

function submitButton(page: SpecPage) {
  const nodes = Array.from(
    page.root!.shadowRoot!.querySelectorAll("authhero-node"),
  );
  for (const node of nodes) {
    const button = Array.from(
      node.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.trim() === "Continue");
    if (button) return button;
  }
  throw new Error("No submit button rendered");
}

describe("hidden inputs on submit", () => {
  it("sends the current value of a hidden input a script changed after render", async () => {
    const page = await newSpecPage({
      components: [AuthheroWidget, AuthheroNode],
      html: `<authhero-widget screen='${JSON.stringify(screen)}'></authhero-widget>`,
    });
    await page.waitForChanges();

    const submitted: Array<Record<string, unknown>> = [];
    page.root!.addEventListener("formSubmit", (e) =>
      submitted.push((e as CustomEvent).detail.data),
    );

    const hidden = page.root!.shadowRoot!.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="fingerprint"]',
    )!;
    expect(hidden.value).toBe("initial");

    // e.g. an inline script filling in a device fingerprint
    hidden.value = "updated";

    submitButton(page).click();
    await page.waitForChanges();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].fingerprint).toBe("updated");
    expect(submitted[0].submit).toBe("true");
  });
});
