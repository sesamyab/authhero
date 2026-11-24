import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CoreAdminContext, Form, TestMemoryRouter } from "ra-core";
import { installDomPolyfills } from "@/test/helpers";
import { SinkFields } from "./sink-fields";

beforeAll(installDomPolyfills);
afterEach(cleanup);

function renderFields(
  mode: "create" | "edit",
  record: { type: string; sink: Record<string, unknown> },
) {
  render(
    <TestMemoryRouter>
      <CoreAdminContext>
        <Form record={{ id: "lst_1", ...record }}>
          <SinkFields mode={mode} />
        </Form>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
}

function renderEdit(sink: Record<string, unknown>) {
  renderFields("edit", { type: "firehose", sink });
  return screen.getByRole("switch", { name: /newline-delimited/i });
}

const SINK = {
  aws_region: "eu-north-1",
  delivery_stream_name: "authhero-logs",
  aws_access_key_id: "AKIDEXAMPLE",
};

describe("SinkFields (edit, firehose)", () => {
  // Delivery treats a missing newline_delimited as true, so the form must too:
  // otherwise saving any field would write false and drop the newlines.
  it("shows newline-delimited on when the stored sink omits it", () => {
    expect(renderEdit(SINK).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a stored newline_delimited: false", () => {
    expect(
      renderEdit({ ...SINK, newline_delimited: false }).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });
});

describe("SinkFields (http)", () => {
  const sink = { http_endpoint: "https://logs.example.com" };

  it("offers to remove the stored Authorization header when editing", () => {
    renderFields("edit", { type: "http", sink });
    expect(
      screen.getByRole("switch", { name: /remove the stored authorization/i }),
    ).toBeTruthy();
    expect(
      screen.getByText(/leave blank to keep the current header/i),
    ).toBeTruthy();
  });

  it("has no remove option when creating", () => {
    renderFields("create", { type: "http", sink });
    expect(
      screen.queryByRole("switch", {
        name: /remove the stored authorization/i,
      }),
    ).toBeNull();
  });
});
