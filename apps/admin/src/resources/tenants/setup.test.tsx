import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import { authProviderWith } from "@/test/helpers";
import { Route, Routes } from "react-router-dom";
import { TenantSetup } from "./setup";

const originalLocation = window.location;

beforeEach(() => {
  // The page sends the user into the tenant with a full navigation, which
  // jsdom does not implement. Record it instead.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, href: "http://localhost/tenants/acme/setup" },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

type Row = {
  id: string;
  friendly_name: string;
  provisioning_state: "pending" | "ready" | "failed";
  provisioning_error?: string;
};

/**
 * `rows` is the tenant as each successive read sees it; `null` stands for a
 * list the tenant is not in (one the user cannot see).
 */
function renderSetup(
  rows: (Row | null)[],
  {
    permissions = [] as string[],
    deploymentOptions = Promise.resolve(null) as Promise<unknown>,
  } = {},
) {
  let call = 0;
  const getList = vi.fn(() => {
    const row = rows[Math.min(call, rows.length - 1)];
    call += 1;
    const data = [
      { id: "other", friendly_name: "Other" },
      ...(row ? [row] : []),
    ];
    return Promise.resolve({ data, total: data.length });
  });
  const createTenantOperation = vi.fn(() =>
    Promise.resolve({ id: "op_retry", kind: "upgrade", status: "pending" }),
  );
  const dataProvider = testDataProvider({
    getList: getList as never,
    getTenantDeploymentOptions: vi.fn(() => deploymentOptions),
    listTenantOperations: vi.fn(() =>
      Promise.resolve({
        operations: [{ id: "op_1", kind: "provision", status: "running" }],
        start: 0,
        limit: 10,
        length: 1,
      }),
    ),
    getTenantOperation: vi.fn(() =>
      Promise.resolve({
        id: "op_1",
        events: [
          { id: "e1", step: "provision-resources", outcome: "succeeded" },
          { id: "e2", step: "seed-defaults", outcome: "started" },
        ],
      }),
    ),
    createTenantOperation,
  });
  render(
    <TestMemoryRouter initialEntries={["/tenants/acme/setup"]}>
      <CoreAdminContext
        dataProvider={dataProvider}
        authProvider={authProviderWith(permissions)}
      >
        <Routes>
          <Route path="/tenants/:tenantId/setup" element={<TenantSetup />} />
        </Routes>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { getList, createTenantOperation };
}

const pending: Row = {
  id: "acme",
  friendly_name: "Acme",
  provisioning_state: "pending",
};
const ready: Row = { ...pending, provisioning_state: "ready" };
const failed: Row = {
  ...pending,
  provisioning_state: "failed",
  provisioning_error: "D1 quota exceeded",
};

describe("TenantSetup", () => {
  it("waits while the tenant is provisioned, then opens it", async () => {
    renderSetup([pending, ready]);
    expect(await screen.findByText("Setting up Acme")).toBeTruthy();
    await waitFor(
      () => expect(screen.getByText("Acme is ready")).toBeTruthy(),
      {
        timeout: 5000,
      },
    );
    await waitFor(() => expect(window.location.href).toBe("/acme"));
  });

  it("reports a tenant the user cannot see instead of opening it", async () => {
    renderSetup([null]);
    expect(await screen.findByText("Tenant not found")).toBeTruthy();
    expect(window.location.href).toBe("http://localhost/tenants/acme/setup");
  });

  it("looks the tenant up by its id", async () => {
    const { getList } = renderSetup([pending]);
    await screen.findByText("Setting up Acme");
    expect(getList).toHaveBeenCalledWith(
      "tenants",
      expect.objectContaining({ filter: { q: 'id:"acme"' } }),
    );
  });

  it("waits for the tenant's host even when it loads before the options", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("not yet")));
    vi.stubGlobal("fetch", fetchMock);
    let answerOptions: (value: unknown) => void = () => {};
    try {
      renderSetup([ready], {
        deploymentOptions: new Promise((resolve) => {
          answerOptions = resolve;
        }),
      });
      await screen.findByText("Acme is ready");
      answerOptions({
        deployment_types: ["wfp"],
        default_deployment_type: "wfp",
        tenant_host_template: "{id}.auth.example.com",
      });
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "https://acme.auth.example.com/.well-known/openid-configuration",
        ),
      );
      expect(screen.getByText("Waiting for it to come online…")).toBeTruthy();
      expect(window.location.href).toBe("http://localhost/tenants/acme/setup");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the provisioning steps to a user who may read operations", async () => {
    renderSetup([pending], { permissions: ["read:tenant_operations"] });
    expect(
      await screen.findByText("Creating the database and worker"),
    ).toBeTruthy();
    expect(screen.getByText("Applying the default configuration")).toBeTruthy();
  });

  it("does not ask for operations without read:tenant_operations", async () => {
    renderSetup([pending]);
    await screen.findByText("Setting up Acme");
    expect(screen.queryByText("Creating the database and worker")).toBeNull();
  });

  it("shows why it failed and lets an operator retry", async () => {
    const { createTenantOperation } = renderSetup([failed, pending], {
      permissions: ["read:tenant_operations", "create:tenant_operations"],
    });
    expect(await screen.findByText("Setting up Acme failed")).toBeTruthy();
    expect(screen.getByText("D1 quota exceeded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(createTenantOperation).toHaveBeenCalledWith("acme", "upgrade"),
    );
    expect(await screen.findByText("Setting up Acme")).toBeTruthy();
  });

  it("points a user without retry rights to support", async () => {
    renderSetup([failed]);
    await screen.findByText("Setting up Acme failed");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.getByText(/Contact support/)).toBeTruthy();
  });

  it("keeps the provisioner's error from a user who may not read operations", async () => {
    renderSetup([failed]);
    await screen.findByText("Setting up Acme failed");
    expect(screen.queryByText("D1 quota exceeded")).toBeNull();
    expect(
      screen.getByText("Something went wrong while setting up your tenant."),
    ).toBeTruthy();
  });
});
