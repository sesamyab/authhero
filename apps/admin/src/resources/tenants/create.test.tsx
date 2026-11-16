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
import { Route, Routes, useParams } from "react-router-dom";
import { installDomPolyfills } from "@/test/helpers";
import { TenantsCreate, createErrorToFieldErrors } from "./create";
import { validateTenantId } from "./deployment";

vi.mock("@/components/admin/cancel-button", () => ({
  CancelButton: () => null,
}));

afterEach(cleanup);
beforeAll(installDomPolyfills);

function SetupStub() {
  const { tenantId } = useParams();
  return <p>Setup page for {tenantId}</p>;
}

function renderCreate(
  deploymentOptions: unknown,
  {
    tenants = [],
    createError,
  }: { tenants?: { id: string }[]; createError?: unknown } = {},
) {
  const create = vi.fn((_resource: string, params: { data: unknown }) =>
    createError
      ? Promise.reject(createError)
      : Promise.resolve({ data: { id: "acme", ...Object(params.data) } }),
  );
  const dataProvider = testDataProvider({
    create: create as never,
    getList: vi.fn(() =>
      Promise.resolve({ data: tenants, total: tenants.length }),
    ) as never,
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
          <Route path="/tenants/:tenantId/setup" element={<SetupStub />} />
        </Routes>
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { create };
}

async function submit(name: string) {
  fireEvent.change(await screen.findByLabelText(/Name/), {
    target: { value: name },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /^(save|create tenant)$/i }),
  );
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

    const shared = await screen.findByRole("radio", { name: /Shared/ });
    expect(shared.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /Dispatch worker/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByText(/dedicated D1 database/)).toBeNull();

    await submit("Acme");

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1].data).toMatchObject({
      deployment_type: "shared",
    });
  });

  it("falls back to both types when the options request fails", async () => {
    renderCreate(new Error("network"));
    await screen.findByRole("radio", { name: /Shared/ });
  });

  it("creates a WFP tenant when that box is picked", async () => {
    const { create } = renderCreate(null);
    fireEvent.click(
      await screen.findByRole("radio", { name: /Dispatch worker/ }),
    );
    await submit("Acme");
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1].data).toMatchObject({
      deployment_type: "wfp",
      storage_kind: "own_d1",
    });
  });
});

describe("TenantsCreate first tenant", () => {
  const wfpOnly = {
    deployment_types: ["wfp"],
    default_deployment_type: "wfp",
  };

  it("opens the setup page of the created tenant", async () => {
    renderCreate(wfpOnly);
    await screen.findByText(/dedicated D1 database/);
    await submit("Acme");
    expect(await screen.findByText("Setup page for acme")).toBeTruthy();
  });

  it("lowercases the id as it is typed", async () => {
    const { create } = renderCreate(wfpOnly);
    await screen.findByText(/dedicated D1 database/);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText(/^ID/), {
      target: { value: "ACME-EU" },
    });
    expect((screen.getByLabelText(/^ID/) as HTMLInputElement).value).toBe(
      "acme-eu",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^(save|create tenant)$/i }),
    );
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1].data).toMatchObject({ id: "acme-eu" });
  });

  it("shows the hostname the tenant will get", async () => {
    renderCreate({
      ...wfpOnly,
      tenant_host_template: "{id}.auth.example.com",
    });
    fireEvent.change(await screen.findByLabelText(/Name/), {
      target: { value: "Acme Corp" },
    });
    expect(
      await screen.findByText(
        "Your tenant will be at acme-corp.auth.example.com. Can't be changed later.",
      ),
    ).toBeTruthy();
  });

  it("states the ID rules when the server sends no hostname", async () => {
    renderCreate(wfpOnly);
    expect(
      await screen.findByText(
        "Lowercase letters, digits and hyphens. Can't be changed later.",
      ),
    ).toBeTruthy();
  });

  it("puts a first tenant's form in the onboarding card", async () => {
    renderCreate(wfpOnly);
    expect(await screen.findByText("Create your first tenant")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create tenant" })).toBeTruthy();
  });

  it("keeps the regular page for a user who has tenants", async () => {
    renderCreate(wfpOnly, { tenants: [{ id: "acme" }] });
    await screen.findByLabelText(/Parent tenant/);
    expect(screen.queryByText("Create your first tenant")).toBeNull();
  });

  it("hides the parent field when the user sees no other tenant", async () => {
    renderCreate(wfpOnly);
    await screen.findByText(/dedicated D1 database/);
    expect(screen.queryByLabelText(/Parent tenant/)).toBeNull();
  });

  it("offers the parent field when there are tenants to inherit from", async () => {
    renderCreate(wfpOnly, { tenants: [{ id: "acme" }] });
    expect(await screen.findByLabelText(/Parent tenant/)).toBeTruthy();
  });

  it("shows the server's refusal on the id field", async () => {
    renderCreate(wfpOnly, {
      createError: Object.assign(
        new Error('The tenant id "local" is reserved.'),
        {
          status: 400,
        },
      ),
    });
    await screen.findByText(/dedicated D1 database/);
    await submit("Local");
    expect(
      await screen.findByText('The tenant id "local" is reserved.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Setup page/)).toBeNull();
  });
});

describe("tenant id helpers", () => {
  it("accepts a lowercase DNS label and refuses anything else", () => {
    expect(validateTenantId("acme-eu")).toBeUndefined();
    expect(validateTenantId("")).toBeUndefined();
    expect(validateTenantId("Acme")).toBeDefined();
    expect(validateTenantId("-acme")).toBeDefined();
    expect(validateTenantId("a".repeat(64))).toBeDefined();
  });

  it("maps a 400 or 409 to the id field and nothing else", () => {
    expect(
      createErrorToFieldErrors({
        status: 409,
        message: "Tenant already exists",
      }),
    ).toEqual({ id: "Tenant already exists" });
    expect(
      createErrorToFieldErrors({
        statusCode: 400,
        body: { message: "Bad id" },
      }),
    ).toEqual({ id: "Bad id" });
    expect(
      createErrorToFieldErrors({ status: 500, message: "boom" }),
    ).toBeUndefined();
    expect(createErrorToFieldErrors(new Error("network"))).toBeUndefined();
  });
});
