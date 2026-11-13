import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  CoreAdminContext,
  ResourceContextProvider,
  TestMemoryRouter,
  testDataProvider,
} from "ra-core";
import { Route, Routes, useParams } from "react-router-dom";
import { authProviderWith, installDomPolyfills } from "@/test/helpers";
import { TenantsList, onboardingTenant } from "./list";

// The vendored admin-kit pieces import `react-router`, which vitest resolves to
// a second router instance with no router in context. Point them at the one
// the test router provides.
vi.mock("react-router", async () => await import("react-router-dom"));
// The real button reads the resource definition, which only <Admin> registers.
vi.mock("@/components/admin/create-button", () => ({
  CreateButton: () => <a href="/tenants/create">Create</a>,
}));

afterEach(cleanup);

beforeAll(installDomPolyfills);

function SetupStub() {
  const { tenantId } = useParams();
  return <p>Setup page for {tenantId}</p>;
}

function renderList({
  tenants = [],
  permissions,
  url = "/tenants",
}: {
  tenants?: {
    id: string;
    friendly_name?: string;
    provisioning_state?: "pending" | "ready" | "failed";
  }[];
  /** "pending" never answers, to see what shows while the token is read. */
  permissions: string[] | null | "pending";
  url?: string;
}) {
  const getOne = vi.fn(() =>
    Promise.reject(Object.assign(new Error("Forbidden"), { statusCode: 403 })),
  );
  const dataProvider = testDataProvider({
    getList: vi.fn((_resource: string, params: { filter?: { q?: string } }) => {
      const q = params.filter?.q;
      const data = q ? tenants.filter((t) => t.id.includes(q)) : tenants;
      return Promise.resolve({ data, total: data.length });
    }) as never,
    getOne: getOne as never,
  });
  render(
    <TestMemoryRouter initialEntries={[url]}>
      <CoreAdminContext
        dataProvider={dataProvider}
        authProvider={authProviderWith(permissions)}
      >
        <ResourceContextProvider value="tenants">
          <Routes>
            <Route path="/tenants" element={<TenantsList />} />
            <Route path="/tenants/:tenantId/setup" element={<SetupStub />} />
          </Routes>
        </ResourceContextProvider>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { getOne };
}

describe("TenantsList empty state", () => {
  it("offers to create the first tenant to a user with create:tenants", async () => {
    renderList({ permissions: ["create:tenants"] });
    expect(
      await screen.findByRole("link", { name: /Create your first tenant/ }),
    ).toBeTruthy();
    expect(screen.getByText("Welcome to AuthHero")).toBeTruthy();
  });

  it("explains who can give access to a user without create:tenants", async () => {
    renderList({ permissions: [] });
    await screen.findByText(/Ask an admin of your organization/);
    expect(
      screen.queryByRole("link", { name: /Create your first tenant/ }),
    ).toBeNull();
  });

  it("shows neither the list nor the empty state until it knows which", async () => {
    renderList({ permissions: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/No tenants yet|Welcome to/)).toBeNull();
    expect(screen.queryByText("Columns")).toBeNull();
    expect(screen.queryByText(/No results/)).toBeNull();
  });

  it("does not ask for the settings without read:tenants", async () => {
    const { getOne } = renderList({ permissions: [] });
    await screen.findByText(/No tenants yet/);
    expect(getOne).not.toHaveBeenCalled();
  });

  it("keeps the list when a search matches nothing", async () => {
    renderList({
      tenants: [{ id: "acme", friendly_name: "Acme" }],
      permissions: ["create:tenants"],
      url: `/tenants?filter=${encodeURIComponent(JSON.stringify({ q: "zzz" }))}`,
    });
    await waitFor(() =>
      expect(screen.queryByText(/No tenants yet/)).toBeNull(),
    );
    expect(screen.queryByText(/Create your first tenant/)).toBeNull();
  });
});

describe("TenantsList actions", () => {
  it("hides Create and Rollouts from a user without the permissions", async () => {
    renderList({
      tenants: [{ id: "acme", friendly_name: "Acme" }],
      permissions: ["read:tenants"],
    });
    await screen.findByText("Acme");
    expect(screen.queryByRole("link", { name: /Create/ })).toBeNull();
    // The settings answer 403, which means no children to roll out to.
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Rollouts/ })).toBeNull(),
    );
  });

  it("shows Create to a user with create:tenants", async () => {
    renderList({
      tenants: [{ id: "acme", friendly_name: "Acme" }],
      permissions: ["create:tenants", "read:tenants"],
    });
    await screen.findByText("Acme");
    expect(await screen.findByRole("link", { name: /Create/ })).toBeTruthy();
  });

  it("shows everything for a pasted token", async () => {
    renderList({
      tenants: [{ id: "acme", friendly_name: "Acme" }],
      permissions: null,
    });
    await screen.findByText("Acme");
    expect(await screen.findByRole("link", { name: /Create/ })).toBeTruthy();
  });
});

describe("TenantsList while onboarding", () => {
  it("takes a user whose only tenant is being set up to its setup page", async () => {
    renderList({
      tenants: [
        { id: "acme", friendly_name: "Acme", provisioning_state: "pending" },
      ],
      permissions: ["create:tenants"],
    });
    expect(await screen.findByText("Setup page for acme")).toBeTruthy();
  });

  it("keeps the list once any tenant is ready", async () => {
    renderList({
      tenants: [
        { id: "acme", friendly_name: "Acme", provisioning_state: "failed" },
        { id: "beta", friendly_name: "Beta", provisioning_state: "ready" },
      ],
      permissions: ["create:tenants"],
    });
    expect(await screen.findByText("Beta")).toBeTruthy();
    expect(screen.queryByText(/Setup page/)).toBeNull();
  });
});

describe("onboardingTenant", () => {
  it("prefers a tenant being set up over a failed one", () => {
    expect(
      onboardingTenant(
        [
          { id: "a", provisioning_state: "failed" },
          { id: "b", provisioning_state: "pending" },
        ],
        2,
      )?.id,
    ).toBe("b");
  });

  it("is undefined when the page does not hold every tenant", () => {
    expect(
      onboardingTenant([{ id: "a", provisioning_state: "pending" }], 5),
    ).toBeUndefined();
  });
});
