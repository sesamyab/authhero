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

interface FakeConnection {
  id: string;
  name: string;
  strategy: string;
}

const httpClient = vi.fn();

vi.mock("@/authProvider", () => ({
  authorizedHttpClient: (...args: unknown[]) => httpClient(...args),
  createOrganizationHttpClient: () => httpClient,
  isSingleTenantForDomain: () => true,
}));
vi.mock("@/TenantContext", () => ({ useTenantId: () => "tenant_1" }));
vi.mock("@/utils/domainUtils", () => ({
  buildUrlWithProtocol: () => "https://api.test",
  formatDomain: (domain: string) => domain,
  getDomainFromStorage: () => [],
  getSelectedDomainFromStorage: () => "api.test",
}));

import { ConnectionsTab } from "./connections-tab";

afterEach(() => {
  cleanup();
  httpClient.mockReset();
});
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

const loginDb = { id: "con_login", name: "login-db", strategy: "auth0" };
const cteDb = { id: "con_cte", name: "cte-users", strategy: "auth0" };
const email = { id: "con_email", name: "email", strategy: "email" };
const google = { id: "con_google", name: "google", strategy: "google-oauth2" };

function renderTab(enabled: FakeConnection[], all: FakeConnection[]) {
  httpClient.mockImplementation(
    async (_url: string, options: { method?: string }) =>
      options.method === "GET"
        ? {
            json: {
              enabled_connections: enabled.map((connection) => ({
                connection_id: connection.id,
                connection,
              })),
            },
          }
        : { json: { enabled_connections: [] } },
  );
  const dataProvider = testDataProvider({
    getList: vi.fn().mockResolvedValue({ data: all, total: all.length }),
  });
  render(
    <TestMemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <RecordContextProvider value={{ id: "client_1" }}>
          <ConnectionsTab />
        </RecordContextProvider>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
}

function patchedIds(): unknown {
  const call = httpClient.mock.calls.find(
    ([, options]) => options?.method === "PATCH",
  );
  return call ? JSON.parse(call[1].body) : undefined;
}

async function addConnection(label: RegExp) {
  fireEvent.click(
    await screen.findByRole("button", { name: /Add connection/ }),
  );
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: label }));
  const addButtons = screen.getAllByRole("button", { name: "Add connection" });
  fireEvent.click(addButtons[addButtons.length - 1]!);
}

describe("ConnectionsTab database connections", () => {
  it("lists database connections in order, the first as default", async () => {
    renderTab([email, loginDb, google, cteDb], [loginDb, cteDb, email, google]);

    const section = (await screen.findByText("Database connections"))
      .parentElement;
    expect(section?.textContent).toMatch(/login-db\s*Default.*cte-users/s);
  });

  it("moves a database connection without disturbing the other slots", async () => {
    renderTab([email, loginDb, google, cteDb], [loginDb, cteDb, email, google]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Move cte-users up" }),
    );

    await waitFor(() =>
      expect(patchedIds()).toEqual([
        "con_email",
        "con_cte",
        "con_google",
        "con_login",
      ]),
    );
  });

  it("adds a second database connection like any other connection", async () => {
    renderTab([loginDb, email], [loginDb, cteDb, email]);

    await addConnection(/cte-users/);

    await waitFor(() =>
      expect(patchedIds()).toEqual(["con_login", "con_email", "con_cte"]),
    );
  });
});
