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
import { HooksCreate } from "./create";
import { HookList } from "./list";

vi.mock("@/components/admin/cancel-button", () => ({
  CancelButton: () => null,
}));

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("trigger binding navigation and creation", () => {
  it("redirects old Hooks bookmarks to the unified Triggers page", async () => {
    render(
      <TestMemoryRouter initialEntries={["/hooks"]}>
        <CoreAdminContext>
          <Routes>
            <Route path="/hooks" element={<HookList />} />
            <Route
              path="/action-triggers"
              element={<div>Unified Triggers</div>}
            />
          </Routes>
        </CoreAdminContext>
      </TestMemoryRouter>,
    );
    expect(await screen.findByText("Unified Triggers")).toBeTruthy();
  });

  it("creates a webhook from a trigger preset, discards old Action fields and returns to Triggers", async () => {
    const create = vi.fn(async (_resource, { data }) => ({
      data: { ...data, id: "h_new", hook_id: "h_new" },
    }));
    const source = encodeURIComponent(
      JSON.stringify({
        type: "url",
        trigger_id: "validate-registration-username",
        code_id: "stale-action",
      }),
    );
    render(
      <TestMemoryRouter initialEntries={[`/hooks/create?source=${source}`]}>
        <CoreAdminContext dataProvider={testDataProvider({ create })}>
          <Routes>
            <Route
              path="/hooks/create"
              element={
                <ResourceContextProvider value="hooks">
                  <HooksCreate />
                </ResourceContextProvider>
              }
            />
            <Route
              path="/action-triggers"
              element={<div>Unified Triggers</div>}
            />
          </Routes>
        </CoreAdminContext>
      </TestMemoryRouter>,
    );
    const url = await screen.findByLabelText(/Webhook URL/);
    fireEvent.change(url, {
      target: { value: "https://example.com/validate" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toBe("hooks");
    expect(create.mock.calls[0][1].data).toMatchObject({
      trigger_id: "validate-registration-username",
      url: "https://example.com/validate",
      enabled: true,
      priority: 0,
    });
    expect(create.mock.calls[0][1].data).not.toHaveProperty("code_id");
    expect(create.mock.calls[0][1].data).not.toHaveProperty("type");
    expect(await screen.findByText("Unified Triggers")).toBeTruthy();
  });
});
