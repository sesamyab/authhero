import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CoreAdminContext, Form, TestMemoryRouter } from "ra-core";
import { installDomPolyfills } from "@/test/helpers";
import { SinkFields } from "./sink-fields";

beforeAll(installDomPolyfills);
afterEach(cleanup);

function renderEdit(sink: Record<string, unknown>) {
  render(
    <TestMemoryRouter>
      <CoreAdminContext>
        <Form record={{ id: "lst_1", type: "firehose", sink }}>
          <SinkFields mode="edit" />
        </Form>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
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
