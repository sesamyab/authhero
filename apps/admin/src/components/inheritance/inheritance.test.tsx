import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  CoreAdminContext,
  RecordContextProvider,
  TestMemoryRouter,
  testDataProvider,
} from "ra-core";
import { Form } from "ra-core";
import { ResourceContextProvider } from "ra-core";
import { TenantProvider } from "@/TenantContext";
import { InheritedFieldset } from "./InheritedFieldset";
import { InheritedBadge } from "./InheritedBadge";
import { InheritedDeleteButton } from "./InheritedDeleteButton";
import { PublishingFields } from "./PublishingFields";
import { useShowInheritance } from "@/hooks/useHasChildren";
import { SyncStatusCard } from "./SyncStatusCard";

afterEach(cleanup);

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SYNCED_ID = "con_sy0123456789abcde";

const status = {
  tenant_id: "acme",
  parent_tenant_id: "partner",
  config_sync: "synced" as const,
  config_sync_hash: "aaaaaaaaaaaaaaaa",
  config_synced_at: "2026-10-26T10:00:00.000Z",
  expected_hash: "bbbbbbbbbbbbbbbb",
  drifted: true,
  chain: ["partner", "control_plane"],
  inherited: { [SYNCED_ID]: "control_plane" },
};

function renderWith(
  record: Record<string, unknown>,
  ui: React.ReactNode,
  overrides: Record<string, unknown> = {},
) {
  const dataProvider = testDataProvider({
    getConfigSyncStatus: vi.fn(() => Promise.resolve(status)),
    ...overrides,
  });
  return render(
    <TestMemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <TenantProvider tenantId="acme">
          <RecordContextProvider value={record}>
            <ResourceContextProvider value="connections">
              <Form record={record}>{ui}</Form>
            </ResourceContextProvider>
          </RecordContextProvider>
        </TenantProvider>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
}

describe("InheritedFieldset", () => {
  it("passes a local row through untouched", () => {
    renderWith(
      { id: "con_local" },
      <InheritedFieldset>
        <input aria-label="name" />
      </InheritedFieldset>,
    );
    expect(screen.queryByTestId("inherited-fieldset")).toBeNull();
    expect(screen.getByLabelText("name").matches(":disabled")).toBe(false);
  });

  it("names the origin and locks a row whose parent allows no changes", async () => {
    renderWith(
      { id: SYNCED_ID, override: "none" },
      <InheritedFieldset>
        <input aria-label="name" />
      </InheritedFieldset>,
    );
    await waitFor(() => expect(screen.getByText("control_plane")).toBeTruthy());
    expect(screen.getByText(/allows no changes/)).toBeTruthy();
    // One sentence in one block, not a line for the name and one for the rest.
    expect(screen.getByRole("alert").textContent).toBe(
      "Inherited from control_plane. The parent allows no changes here.",
    );
    expect(screen.getByLabelText("name").matches(":disabled")).toBe(true);
  });

  it("leaves a row editable when the parent allows field changes", async () => {
    renderWith(
      { id: SYNCED_ID, override: "fields" },
      <InheritedFieldset>
        <input aria-label="name" />
      </InheritedFieldset>,
    );
    await waitFor(() => expect(screen.getByText("control_plane")).toBeTruthy());
    expect(screen.getByLabelText("name").matches(":disabled")).toBe(false);
  });

  it("falls back to the parent when the status is unavailable", async () => {
    renderWith(
      { id: SYNCED_ID, override: "secrets", enforce: true },
      <InheritedFieldset>
        <input aria-label="name" />
      </InheritedFieldset>,
      { getConfigSyncStatus: vi.fn(() => Promise.reject(new Error("403"))) },
    );
    await waitFor(() =>
      expect(screen.getByText("a parent tenant")).toBeTruthy(),
    );
    expect(screen.getByText(/Only secrets/)).toBeTruthy();
    expect(screen.getByText(/cannot be disabled/)).toBeTruthy();
  });
});

describe("InheritedDeleteButton", () => {
  const deleteButton = () => screen.queryByRole("button", { name: /delete/i });

  it("offers Delete on a local row", () => {
    renderWith({ id: "con_local" }, <InheritedDeleteButton />);
    expect(deleteButton()).toBeTruthy();
  });

  it("offers Delete on a copy the parent does not enforce, even when locked", async () => {
    renderWith({ id: SYNCED_ID, override: "none" }, <InheritedDeleteButton />);
    await waitFor(() => expect(deleteButton()).toBeTruthy());
  });

  it("leaves Delete out on an enforced copy", () => {
    renderWith(
      { id: SYNCED_ID, override: "none", enforce: true },
      <InheritedDeleteButton />,
    );
    expect(deleteButton()).toBeNull();
  });
});

describe("InheritedBadge", () => {
  it("marks synced rows and published rows, and leaves local ones plain", () => {
    const { rerender } = render(
      <RecordContextProvider value={{ id: SYNCED_ID }}>
        <InheritedBadge />
      </RecordContextProvider>,
    );
    expect(screen.getByText("inherited")).toBeTruthy();

    rerender(
      <RecordContextProvider value={{ id: "con_x", scope: "shared" }}>
        <InheritedBadge />
      </RecordContextProvider>,
    );
    expect(screen.getByText("shared")).toBeTruthy();

    rerender(
      <RecordContextProvider value={{ id: "con_x" }}>
        <InheritedBadge />
      </RecordContextProvider>,
    );
    expect(screen.getByText("local")).toBeTruthy();
  });
});

describe("PublishingFields", () => {
  it("offers scope, and override and enforce once the row is published", async () => {
    renderWith({ id: "con_x", scope: "shared" }, <PublishingFields />);
    expect(screen.getByText("Publishing")).toBeTruthy();
    expect(await screen.findByText("Override")).toBeTruthy();
    expect(screen.getByText("Enforce")).toBeTruthy();
  });

  it("hides override and enforce for a local row", () => {
    renderWith({ id: "con_x", scope: "local" }, <PublishingFields />);
    expect(screen.getByText("Publishing")).toBeTruthy();
    expect(screen.queryByText("Override")).toBeNull();
  });

  it("is not shown on a copy inherited from a parent", () => {
    renderWith({ id: SYNCED_ID }, <PublishingFields />);
    expect(screen.queryByText("Publishing")).toBeNull();
  });

  it("is hidden once the tenant is known to have no children", async () => {
    const getOne = vi.fn(() =>
      Promise.resolve({ data: { id: "settings", has_children: false } }),
    );
    renderWith({ id: "con_x", scope: "shared" }, <PublishingFields />, {
      getOne,
    });
    await waitFor(() => expect(screen.queryByText("Publishing")).toBeNull());
    expect(getOne).toHaveBeenCalledWith(
      "settings",
      expect.objectContaining({ id: "settings" }),
    );
  });

  it("stays when the tenant has children, or the server does not say", async () => {
    const getOne = vi.fn(() =>
      Promise.resolve({ data: { id: "settings", has_children: true } }),
    );
    renderWith({ id: "con_x", scope: "shared" }, <PublishingFields />, {
      getOne,
    });
    await waitFor(() => expect(getOne).toHaveBeenCalled());
    expect(screen.getByText("Publishing")).toBeTruthy();
  });

  it("stays while the answer is still loading", () => {
    const getOne = vi.fn(() => new Promise(() => {}));
    renderWith({ id: "con_x", scope: "shared" }, <PublishingFields />, {
      getOne,
    });
    expect(screen.getByText("Publishing")).toBeTruthy();
  });
});

describe("SyncStatusCard", () => {
  it("shows drift for a synced tenant", async () => {
    renderWith({}, <SyncStatusCard tenantId="acme" />);
    await waitFor(() => expect(screen.getByText("Out of date")).toBeTruthy());
    // The parent and the chain link to those tenants' own admins.
    const partner = screen.getAllByRole("link", { name: "partner" });
    expect(partner[0]!.getAttribute("href")).toBe("/partner");
    expect(
      screen.getByRole("link", { name: "control_plane" }).getAttribute("href"),
    ).toBe("/control_plane");
    expect(screen.getByText("aaaaaaaaaaaa")).toBeTruthy();
  });

  it("shows an in-sync tenant, and nothing for a tenant on inherit-on-read as drift", async () => {
    renderWith({}, <SyncStatusCard tenantId="acme" />, {
      getConfigSyncStatus: vi.fn(() =>
        Promise.resolve({ ...status, drifted: false }),
      ),
    });
    await waitFor(() => expect(screen.getByText("In sync")).toBeTruthy());
  });
});

describe("useShowInheritance", () => {
  function Probe() {
    return <span>{useShowInheritance() ? "show" : "hide"}</span>;
  }
  const settings = (data: Record<string, unknown>) => ({
    getOne: vi.fn(() => Promise.resolve({ data: { id: "settings", ...data } })),
  });

  it("hides the source columns on a tenant with nothing above or below it", async () => {
    renderWith({}, <Probe />, settings({ has_children: false }));
    expect(await screen.findByText("hide")).toBeTruthy();
  });

  it.each([
    ["has children", { has_children: true }],
    ["has a parent", { has_children: false, parent_tenant_id: "partner" }],
    ["is synced", { has_children: false, config_sync: "synced" }],
  ])("shows them when the tenant %s", async (_name, data) => {
    const provider = settings(data);
    renderWith({}, <Probe />, provider);
    await waitFor(() => expect(provider.getOne).toHaveBeenCalled());
    expect(screen.getByText("show")).toBeTruthy();
  });
});
