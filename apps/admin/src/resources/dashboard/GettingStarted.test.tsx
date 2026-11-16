import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import { TenantProvider } from "@/TenantContext";
import {
  GettingStarted,
  isBrandingConfigured,
  isOwnApplication,
  type GettingStartedProgress,
} from "./GettingStarted";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

// What a freshly provisioned tenant has: its Default App and an M2M client.
const provisionedClients = [
  { id: "app_default", client_id: "app_default", app_type: "regular_web" },
  { id: "app_m2m", client_id: "app_m2m", app_type: "non_interactive" },
];

type TenantData = {
  clients?: { id: string; client_id: string; app_type: string }[];
  logins?: { id: string }[];
  branding?: Record<string, unknown>;
  /** Resources the user may not read: their requests answer 403. */
  forbidden?: string[];
  /** The tenant being administered is the control plane. */
  controlPlane?: boolean;
};

const forbiddenError = () =>
  Promise.reject(Object.assign(new Error("Forbidden"), { statusCode: 403 }));

function renderCard(
  progress: GettingStartedProgress,
  {
    clients = provisionedClients,
    logins = [],
    branding = {},
    forbidden = [],
    controlPlane = false,
  }: TenantData = {},
) {
  const lists: Record<string, unknown[]> = {
    clients,
    logs: logins,
  };
  const dataProvider = testDataProvider({
    getOne: vi.fn((resource: string) =>
      forbidden.includes(resource)
        ? forbiddenError()
        : Promise.resolve({
            data:
              resource === "settings"
                ? {
                    id: "settings",
                    default_client_id: "app_default",
                    is_control_plane: controlPlane,
                  }
                : { id: "branding", ...branding },
          }),
    ) as never,
    getList: vi.fn((resource: string) => {
      if (forbidden.includes(resource)) return forbiddenError();
      const data = lists[resource] ?? [];
      return Promise.resolve({ data, total: data.length });
    }) as never,
  });
  return render(
    <TestMemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <TenantProvider tenantId="acme">
          <GettingStarted progress={progress} loading={false} />
        </TenantProvider>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
}

const requiredDone: TenantData = {
  clients: [
    ...provisionedClients,
    { id: "acme-web", client_id: "acme-web", app_type: "spa" },
  ],
  logins: [{ id: "log_1" }],
  branding: { logo_url: "https://acme.example/logo.png" },
};

describe("isOwnApplication", () => {
  it("does not count the Default App or machine-to-machine clients", () => {
    expect(
      isOwnApplication(
        { client_id: "app_default", app_type: "regular_web" },
        "app_default",
      ),
    ).toBe(false);
    expect(
      isOwnApplication(
        { client_id: "app_m2m", app_type: "non_interactive" },
        "app_default",
      ),
    ).toBe(false);
  });

  it("counts an application the tenant created", () => {
    expect(
      isOwnApplication(
        { client_id: "acme-web", app_type: "spa" },
        "app_default",
      ),
    ).toBe(true);
  });
});

describe("isBrandingConfigured", () => {
  it("does not count the defaults the server answers with", () => {
    expect(
      isBrandingConfigured({
        logo_url:
          "https://assets.sesamy.com/static/images/sesamy/logos/sesamy_logo_black.svg",
        colors: { primary: "#7D68F4" },
      }),
    ).toBe(false);
    expect(isBrandingConfigured({})).toBe(false);
  });

  it("counts a logo or a primary color of the tenant's own", () => {
    expect(
      isBrandingConfigured({ logo_url: "https://acme.example/logo.png" }),
    ).toBe(true);
    expect(isBrandingConfigured({ colors: { primary: "#ff0000" } })).toBe(true);
  });
});

describe("GettingStarted", () => {
  it("lists every required step as open for a freshly provisioned tenant", async () => {
    renderCard({ users: 0 });
    expect(await screen.findByText("Get started")).toBeTruthy();
    expect(
      screen.getByText("4 of 4 steps left to set up this tenant."),
    ).toBeTruthy();
  });

  it("counts a login however long ago it was", async () => {
    renderCard({ users: 0 }, { logins: [{ id: "log_old" }] });
    expect(
      await screen.findByText("3 of 4 steps left to set up this tenant."),
    ).toBeTruthy();
  });

  it("fills the progress segment of each step that is done", async () => {
    renderCard({ users: 1 }, { logins: [{ id: "log_1" }] });
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    // In step order: application, login, users, branding.
    expect(
      Array.from(bar.children).map((s) => s.getAttribute("data-done")),
    ).toEqual(["false", "true", "true", "false"]);
  });

  // Each case starts from a new tenant, where the card shows (see the first
  // test), and changes one thing.
  it.each<[string, GettingStartedProgress, TenantData]>([
    ["every step is done", { users: 1 }, requiredDone],
    ["part of the setup cannot be read", { users: 0 }, { forbidden: ["logs"] }],
    ["the user count could not be read", {}, {}],
    ["the tenant is the control plane", { users: 0 }, { controlPlane: true }],
  ])("is not shown when %s", async (_, progress, tenant) => {
    renderCard(progress, tenant);
    // Wait for the answers before asserting nothing is shown.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Get started")).toBeNull();
  });

  it("stays dismissed for the tenant", async () => {
    const { unmount } = renderCard({ users: 0 });
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss getting started" }),
    );
    expect(screen.queryByText("Get started")).toBeNull();
    unmount();

    renderCard({ users: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Get started")).toBeNull();
  });
});
