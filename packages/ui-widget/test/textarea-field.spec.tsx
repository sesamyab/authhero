// `h` is the JSX factory Stencil compiles these templates against — used by
// the transform, never referenced by name.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { h } from "@stencil/core";
import { newSpecPage } from "@stencil/core/testing";
import { AuthheroNode } from "../src/components/authhero-node/authhero-node";
import type { FormComponent } from "../src/types/components";

function textarea(defaultValue?: string) {
  return {
    id: "callbacks",
    type: "TEXT",
    category: "FIELD",
    label: "Callback URLs",
    config: {
      multiline: true,
      ...(defaultValue ? { default_value: defaultValue } : {}),
    },
  } as FormComponent;
}

async function renderServerSide(component: FormComponent) {
  const page = await newSpecPage({
    components: [AuthheroNode],
    template: () => <authhero-node component={component}></authhero-node>,
    hydrateServerSide: true,
  });
  const html = page.root!.outerHTML;
  const match = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
  if (!match) throw new Error("No textarea rendered");
  return match[1];
}

describe("multiline TEXT field", () => {
  // SSR annotates vdom text nodes with <!--t.N--> comments. Inside a textarea
  // that comment is raw text, so it showed up as the field's content.
  it("renders an empty textarea server-side without hydration markers", async () => {
    expect(await renderServerSide(textarea())).toBe("");
  });

  it("renders the default value as the textarea body server-side", async () => {
    const body = await renderServerSide(
      textarea("https://app.example.com/callback"),
    );
    expect(body).toBe("https://app.example.com/callback");
  });

  // mock-doc has no textarea `value` property, so assert the rendered
  // content (the browser applies `value` as a property on top of this).
  it("renders the bound value on the client", async () => {
    const page = await newSpecPage({
      components: [AuthheroNode],
      template: () => (
        <authhero-node
          component={textarea()}
          value={"https://a.example\nhttps://b.example"}
        ></authhero-node>
      ),
    });
    const el = page.root!.shadowRoot!.querySelector("textarea")!;
    expect(el.textContent).toBe("https://a.example\nhttps://b.example");
    expect(el.childNodes).toHaveLength(1);
  });
});

// The label floats via `.input-field:not(:placeholder-shown) + .input-label`,
// so it must come right after the field with a placeholder attribute. A label
// rendered before the field never moved and the typed text ran into it.
describe("floating labels on textarea and URL fields", () => {
  const url = {
    id: "logo_uri",
    type: "URL",
    category: "FIELD",
    label: "Logo URL",
  } as FormComponent;

  async function render(component: FormComponent, value?: string) {
    const page = await newSpecPage({
      components: [AuthheroNode],
      template: () => (
        <authhero-node component={component} value={value}></authhero-node>
      ),
    });
    const root = page.root!.shadowRoot!;
    const field = root.querySelector(".input-field")!;
    return { field, label: field.nextElementSibling };
  }

  it("renders the textarea label after the field, inside a textarea container", async () => {
    const { field, label } = await render(textarea());
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.getAttribute("placeholder")).toBe(" ");
    expect(label?.className).toBe("input-label");
    expect(field.parentElement?.classList.contains("textarea-container")).toBe(
      true,
    );
  });

  it("floats the textarea label once there is a value", async () => {
    const { label } = await render(textarea(), "https://a.example");
    expect(label?.className).toBe("input-label floating");
  });

  it("renders the URL label after the input", async () => {
    const { field, label } = await render(url);
    expect(field.getAttribute("type")).toBe("url");
    expect(field.getAttribute("placeholder")).toBe(" ");
    expect(label?.className).toBe("input-label");
  });

  it("floats the URL label once there is a value", async () => {
    const { label } = await render(url, "https://a.example/logo.png");
    expect(label?.className).toBe("input-label floating");
  });
});
