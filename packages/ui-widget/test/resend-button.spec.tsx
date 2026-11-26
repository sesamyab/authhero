import { newSpecPage, SpecPage } from "@stencil/core/testing";
import { AuthheroWidget } from "../src/components/authhero-widget/authhero-widget";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import type { UiScreen } from "../src/types/components";

const codeScreen: UiScreen = {
  name: "email-otp-challenge",
  title: "Check your email",
  action: "/u2/screen/email-otp-challenge?state=abc",
  method: "POST",
  components: [
    {
      id: "code",
      type: "TEXT",
      category: "FIELD",
      visible: true,
      required: true,
      order: 0,
      config: {},
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      visible: true,
      order: 1,
      config: { text: "Continue" },
    },
    {
      id: "resend",
      type: "RESEND_BUTTON",
      category: "BLOCK",
      visible: true,
      order: 2,
      config: { text: "Resend code" },
    },
  ],
} as UiScreen;

async function render() {
  const page = await newSpecPage({
    components: [AuthheroWidget, AuthheroNode],
    html: `<authhero-widget auto-submit="true" state="abc" screen='${JSON.stringify(codeScreen)}'></authhero-widget>`,
  });
  await page.waitForChanges();
  return page;
}

function resendButton(page: SpecPage) {
  const nodes = Array.from(
    page.root!.shadowRoot!.querySelectorAll("authhero-node"),
  );
  for (const node of nodes) {
    const button = Array.from(
      node.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.trim() === "Resend code");
    if (button) return button;
  }
  throw new Error("No resend button rendered");
}

async function flush(page: SpecPage) {
  await page.waitForChanges();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await page.waitForChanges();
}

describe("resend button", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("POSTs action=resend as JSON to the screen action and renders the returned screen", async () => {
    const page = await render();

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        screen: {
          ...codeScreen,
          messages: [{ text: "A new code has been sent", type: "success" }],
        },
      }),
    });
    (global as any).fetch = fetchSpy;

    // The required code field is empty: resend must not be gated on it.
    resendButton(page).click();
    await flush(page);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/u2/screen/email-otp-challenge?state=abc");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ data: { action: "resend" } });

    expect(page.root!.shadowRoot!.textContent).toContain(
      "A new code has been sent",
    );
  });

  it("keeps action=resend when the form has a hidden input named action", async () => {
    const page = await render();

    // e.g. added by a tenant's prompt partial or an inline script
    const form = page.root!.shadowRoot!.querySelector("form")!;
    const hidden = page.doc.createElement("input");
    hidden.setAttribute("type", "hidden");
    hidden.setAttribute("name", "action");
    hidden.setAttribute("value", "verify");
    form.appendChild(hidden);

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ screen: codeScreen }),
    });
    (global as any).fetch = fetchSpy;

    resendButton(page).click();
    await flush(page);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).data.action).toBe(
      "resend",
    );
  });

  it("renders the server's error when the resend fails", async () => {
    const page = await render();

    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => "application/json" },
      json: async () => ({
        screen: {
          ...codeScreen,
          messages: [{ text: "Failed to resend the code", type: "error" }],
        },
      }),
    });

    resendButton(page).click();
    await flush(page);

    expect(page.root!.shadowRoot!.textContent).toContain(
      "Failed to resend the code",
    );
  });

  it("leaves the request to the host page when autoSubmit is off", async () => {
    const page = await newSpecPage({
      components: [AuthheroWidget, AuthheroNode],
      html: `<authhero-widget screen='${JSON.stringify(codeScreen)}'></authhero-widget>`,
    });
    await page.waitForChanges();

    const fetchSpy = jest.fn();
    (global as any).fetch = fetchSpy;
    const submitted: Array<Record<string, unknown>> = [];
    page.root!.addEventListener("formSubmit", (e) =>
      submitted.push((e as CustomEvent).detail.data),
    );

    resendButton(page).click();
    await flush(page);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submitted).toEqual([{ action: "resend" }]);
  });
});
