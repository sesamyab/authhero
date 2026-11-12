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
  ResourceContextProvider,
  TestMemoryRouter,
  testDataProvider,
} from "ra-core";
import { Route, Routes } from "react-router-dom";
import { TenantsCreate } from "./create";

vi.mock("@/components/admin/cancel-button", () => ({
  CancelButton: () => null,
}));

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderCreate(deploymentOptions: unknown) {
  const create = vi.fn((_resource: string, params: { data: unknown }) =>
    Promise.resolve({ data: { id: "acme", ...Object(params.data) } }),
  );
  const dataProvider = testDataProvider({
    create: create as never,
    getTenantDeploymentOptions: vi.fn(() =>
      deploymentOptions instanceof Error
        ? Promise.reject(deploymentOptions)
        : Promise.resolve(deploymentOptions),
    ),
  });
  render(
    <TestMemoryRouter initialEntries={["/tenants/create"]}>
      <CoreAdminContext dataProvider={dataProvider}>
        <Routes>
          <Route
            path="/tenants/create"
            element={
              <ResourceContextProvider value="tenants">
                <TenantsCreate />
              </ResourceContextProvider>
            }
          />
        </Routes>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { create };
}

async function submit(name: string) {
  fireEvent.change(screen.getByLabelText(/Name/), {
    target: { value: name },
  });
  fireEvent.click(await screen.findByRole("button", { name: /save/i }));
}

describe("TenantsCreate deployment type", () => {
  it("hides the choice and creates a WFP tenant on a WFP-only cluster", async () => {
    const { create } = renderCreate({
      deployment_types: ["wfp"],
      default_deployment_type: "wfp",
    });

    await screen.findByText(/dedicated D1 database/);
    expect(screen.queryByText(/Shared/)).toBeNull();

    await submit("Acme");

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1].data).toMatchObject({
      friendly_name: "Acme",
      deployment_type: "wfp",
      storage_kind: "own_d1",
    });
  });

  it("offers both types when the server predates the options endpoint", async () => {
    const { create } = renderCreate(null);

    await screen.findByText("Shared (default)");
    expect(screen.getByText("Dispatch worker (WFP)")).toBeTruthy();
    expect(screen.queryByText(/dedicated D1 database/)).toBeNull();

    await submit("Acme");

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1].data).toMatchObject({
      deployment_type: "shared",
    });
  });

  it("falls back to both types when the options request fails", async () => {
    renderCreate(new Error("network"));
    await screen.findByText("Shared (default)");
  });
});
