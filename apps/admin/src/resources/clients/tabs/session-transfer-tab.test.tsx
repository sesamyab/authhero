import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, Form, TestMemoryRouter } from "ra-core";
import { SessionTransferTab } from "./session-transfer-tab";

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderTab(sessionTransfer: Record<string, unknown>) {
  const onSubmit = vi.fn();
  render(
    <TestMemoryRouter>
      <CoreAdminContext>
        <Form
          record={{ id: "client_1", session_transfer: sessionTransfer }}
          onSubmit={onSubmit}
        >
          <SessionTransferTab />
          <button type="submit">Save</button>
        </Form>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return onSubmit;
}

async function submitted(onSubmit: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const [values]: unknown[] = onSubmit.mock.calls[0] ?? [];
  return values;
}

const isChecked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true";

describe("SessionTransferTab", () => {
  it("shows an unconfigured client as off and saves nothing into it", async () => {
    const onSubmit = renderTab({});

    expect(
      isChecked(
        screen.getByRole("switch", { name: "Create session transfer tokens" }),
      ),
    ).toBe(false);
    expect(
      isChecked(screen.getByRole("checkbox", { name: /Query parameter/ })),
    ).toBe(false);
    // Settings of a side that is off stay out of the way.
    expect(screen.queryByRole("switch", { name: "Cascade revocation" })).toBe(
      null,
    );
    expect(screen.queryByText("Device binding")).toBe(null);

    expect(await submitted(onSubmit)).toEqual({
      id: "client_1",
      session_transfer: {},
    });
  });

  it("shows the default for a setting that was never written, and writes only what was toggled", async () => {
    const onSubmit = renderTab({});

    fireEvent.click(
      screen.getByRole("switch", { name: "Create session transfer tokens" }),
    );

    // Defaults to on in the API, so it must not read as off here.
    expect(
      isChecked(screen.getByRole("switch", { name: "Cascade revocation" })),
    ).toBe(true);
    expect(
      isChecked(screen.getByRole("switch", { name: "Allow onward transfer" })),
    ).toBe(false);

    const values = await submitted(onSubmit);
    expect(values).toEqual({
      id: "client_1",
      session_transfer: { can_create_session_transfer_token: true },
    });
  });

  it("turns a default-on setting off when asked", async () => {
    const onSubmit = renderTab({ can_create_session_transfer_token: true });

    fireEvent.click(screen.getByRole("switch", { name: "Cascade revocation" }));

    expect(await submitted(onSubmit)).toMatchObject({
      session_transfer: {
        can_create_session_transfer_token: true,
        enforce_cascade_revocation: false,
      },
    });
  });

  it("reveals the receiving settings with IP binding selected once a method is ticked", async () => {
    const onSubmit = renderTab({});

    fireEvent.click(screen.getByRole("checkbox", { name: /Query parameter/ }));

    expect(
      isChecked(screen.getByRole("radio", { name: "Same IP address" })),
    ).toBe(true);
    expect(screen.queryByRole("alert")).toBe(null);
    // Only matters once refresh tokens are issued.
    expect(
      screen.queryByRole("switch", {
        name: "Bind refresh tokens to the session",
      }),
    ).toBe(null);

    fireEvent.click(
      screen.getByRole("switch", { name: "Issue refresh tokens" }),
    );
    expect(
      isChecked(
        screen.getByRole("switch", {
          name: "Bind refresh tokens to the session",
        }),
      ),
    ).toBe(true);

    expect(await submitted(onSubmit)).toMatchObject({
      session_transfer: {
        allowed_authentication_methods: ["query"],
        allow_refresh_token: true,
      },
    });
  });

  it("warns when tokens are accepted in the URL with no device check", () => {
    renderTab({
      allowed_authentication_methods: ["cookie", "query"],
      enforce_device_binding: "none",
    });

    expect(isChecked(screen.getByRole("radio", { name: "No check" }))).toBe(
      true,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Links can log anyone in",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Query parameter/ }));
    expect(screen.queryByRole("alert")).toBe(null);
  });

  it("writes the chosen device binding", async () => {
    const onSubmit = renderTab({ allowed_authentication_methods: ["cookie"] });

    fireEvent.click(screen.getByRole("radio", { name: "Same network (ASN)" }));

    expect(await submitted(onSubmit)).toMatchObject({
      session_transfer: {
        allowed_authentication_methods: ["cookie"],
        enforce_device_binding: "asn",
      },
    });
  });
});
