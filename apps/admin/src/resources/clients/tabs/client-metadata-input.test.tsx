import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, Form, TestMemoryRouter } from "ra-core";
import { TextInput } from "@/components/admin";
import { ClientMetadataInput } from "./details-tab";

afterEach(cleanup);

function renderInput(clientMetadata: Record<string, string>) {
  const onSubmit = vi.fn();
  render(
    <TestMemoryRouter>
      <CoreAdminContext>
        <Form
          record={{ id: "client_1", client_metadata: clientMetadata }}
          onSubmit={onSubmit}
        >
          <TextInput source="client_metadata.tos_uri" label="Terms URL" />
          <ClientMetadataInput />
          <button type="submit">Save</button>
        </Form>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return onSubmit;
}

async function submittedMetadata(onSubmit: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const [values] = onSubmit.mock.calls[0] ?? [];
  return (values as { client_metadata: Record<string, unknown> })
    .client_metadata;
}

describe("ClientMetadataInput", () => {
  it("keeps the legal URLs when another row is removed", async () => {
    const onSubmit = renderInput({
      email_validation: "enabled",
      tos_uri: "https://e.com/terms",
      policy_uri: "https://e.com/privacy",
      foo: "bar",
    });

    // The legal URLs have their own inputs, so they aren't metadata rows.
    expect(screen.getAllByPlaceholderText("Key")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Remove metadata entry"));

    expect(await submittedMetadata(onSubmit)).toEqual({
      email_validation: "enabled",
      tos_uri: "https://e.com/terms",
      policy_uri: "https://e.com/privacy",
    });
  });

  it("keeps a legal URL edited earlier in the same session", async () => {
    const onSubmit = renderInput({
      tos_uri: "https://e.com/old",
      foo: "bar",
    });

    fireEvent.change(screen.getByLabelText("Terms URL"), {
      target: { value: "https://e.com/new" },
    });
    fireEvent.change(screen.getByPlaceholderText("Value"), {
      target: { value: "baz" },
    });

    expect(await submittedMetadata(onSubmit)).toEqual({
      tos_uri: "https://e.com/new",
      foo: "baz",
    });
  });

  it("treats universal_login_version as a dedicated key, not a row", async () => {
    const onSubmit = renderInput({
      universal_login_version: "2",
      foo: "bar",
    });

    expect(screen.getAllByPlaceholderText("Key")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Remove metadata entry"));

    expect(await submittedMetadata(onSubmit)).toEqual({
      universal_login_version: "2",
    });
  });
});
