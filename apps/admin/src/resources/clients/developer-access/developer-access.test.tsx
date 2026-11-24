import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  CoreAdminContext,
  RecordContextProvider,
  TestMemoryRouter,
  testDataProvider,
} from "ra-core";
import { InviteDeveloperButton } from "./invite-dialog";
import { DeveloperAccessTab, isInvitedClient } from "./developer-access-tab";

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const DAY = 24 * 60 * 60;

describe("InviteDeveloperButton", () => {
  it("creates an invite from a preset and shows the link once", async () => {
    const createDeveloperInvite = vi.fn().mockResolvedValue({
      id: "inv_1",
      ticket: "https://login.example.com/u2/self-service/app?ticket=abc",
      expires_at: new Date(Date.now() + 7 * DAY * 1000).toISOString(),
    });
    const dataProvider = {
      ...testDataProvider(),
      createDeveloperInvite,
    };

    render(
      <TestMemoryRouter>
        <CoreAdminContext dataProvider={dataProvider}>
          <InviteDeveloperButton />
        </CoreAdminContext>
      </TestMemoryRouter>,
    );

    fireEvent.click(screen.getByText("Invite a developer"));
    fireEvent.click(screen.getByText("Single-page app"));
    const create = screen.getByRole("button", { name: "Create link" });
    expect(create).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Who is this for?"), {
      target: { value: "Agency web app" },
    });
    fireEvent.click(create);

    await waitFor(() => expect(createDeveloperInvite).toHaveBeenCalled());
    expect(createDeveloperInvite).toHaveBeenCalledWith({
      preset: "spa",
      name: "Agency web app",
      expires_in_seconds: 7 * DAY,
      is_first_party: true,
    });
    expect(
      await screen.findByDisplayValue(
        "https://login.example.com/u2/self-service/app?ticket=abc",
      ),
    ).toBeTruthy();
  });
});

describe("DeveloperAccessTab", () => {
  it("generates an edit link and revokes the app's active tokens", async () => {
    const createClientRegistrationTicket = vi.fn().mockResolvedValue({
      id: "rat_2",
      ticket: "https://login.example.com/u2/self-service/app?ticket=edit",
      expires_at: new Date(Date.now() + 7 * DAY * 1000).toISOString(),
    });
    const revokeClientRegistrationToken = vi.fn().mockResolvedValue(undefined);
    const listClientRegistrationTokens = vi.fn().mockResolvedValue([
      {
        id: "inv_1",
        type: "iat",
        source: "invite",
        name: "Agency iOS",
        status: "used",
        single_use: true,
        created_at: "2026-11-20T10:00:00.000Z",
        used_at: "2026-11-21T10:00:00.000Z",
      },
      {
        id: "rat_1",
        type: "rat",
        source: "edit_link",
        status: "active",
        single_use: false,
        created_at: "2026-11-22T10:00:00.000Z",
        expires_at: "2026-11-29T10:00:00.000Z",
      },
    ]);
    const dataProvider = {
      ...testDataProvider(),
      createClientRegistrationTicket,
      revokeClientRegistrationToken,
      listClientRegistrationTokens,
    };

    render(
      <TestMemoryRouter>
        <CoreAdminContext dataProvider={dataProvider}>
          <RecordContextProvider value={{ id: "client_1" }}>
            <DeveloperAccessTab />
          </RecordContextProvider>
        </CoreAdminContext>
      </TestMemoryRouter>,
    );

    expect(await screen.findByText("Agency iOS")).toBeTruthy();
    expect(listClientRegistrationTokens).toHaveBeenCalledWith({
      client_id: "client_1",
    });

    fireEvent.click(screen.getByText("Generate edit link"));
    fireEvent.click(screen.getByRole("switch", { name: /30 days/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate link" }));
    await waitFor(() =>
      expect(createClientRegistrationTicket).toHaveBeenCalledWith(
        "client_1",
        30 * DAY,
      ),
    );
    expect(
      await screen.findByDisplayValue(
        "https://login.example.com/u2/self-service/app?ticket=edit",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fireEvent.click(screen.getByText("Revoke all developer access"));
    await waitFor(() =>
      expect(revokeClientRegistrationToken).toHaveBeenCalledWith("rat_1"),
    );
    expect(revokeClientRegistrationToken).not.toHaveBeenCalledWith("inv_1");
  });
});

describe("isInvitedClient", () => {
  it("is true only for apps registered through an invite", () => {
    expect(
      isInvitedClient({
        id: "a",
        registration_type: "iat_dcr",
        registration_metadata: { registration_token_id: "inv_1" },
      }),
    ).toBe(true);
    expect(isInvitedClient({ id: "b", registration_type: "iat_dcr" })).toBe(
      false,
    );
    expect(isInvitedClient({ id: "c", registration_type: "manual" })).toBe(
      false,
    );
  });
});
