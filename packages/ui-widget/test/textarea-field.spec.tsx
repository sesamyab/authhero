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
