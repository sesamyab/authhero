import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { CoreAdminContext, testDataProvider } from "ra-core";
import { useHasReadyTenant } from "./useHasReadyTenant";

function renderWithTenants(
  tenantId: string | undefined,
  getList: () => Promise<unknown>,
) {
  const dataProvider = testDataProvider({ getList: vi.fn(getList) as never });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CoreAdminContext dataProvider={dataProvider}>{children}</CoreAdminContext>
  );
  return {
    ...renderHook(() => useHasReadyTenant(tenantId), { wrapper }),
    getList: dataProvider.getList,
  };
}

const answer = (data: { id: string; provisioning_state?: string }[]) => () =>
  Promise.resolve({ data, total: data.length });

describe("useHasReadyTenant", () => {
  it("is false for a user who sees no tenant", async () => {
    const { result } = renderWithTenants(undefined, answer([]));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is false while the only tenants are being set up or failed", async () => {
    const { result } = renderWithTenants(
      undefined,
      answer([
        { id: "acme", provisioning_state: "pending" },
        { id: "acme-eu", provisioning_state: "failed" },
      ]),
    );
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is true once a tenant is ready, including one from before states", async () => {
    const { result } = renderWithTenants(
      undefined,
      answer([{ id: "acme", provisioning_state: "pending" }, { id: "legacy" }]),
    );
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is true inside a tenant without asking", () => {
    const { result, getList } = renderWithTenants("acme", answer([]));
    expect(result.current).toBe(true);
    expect(getList).not.toHaveBeenCalled();
  });

  it("keeps the navigation when the question fails", async () => {
    const { result } = renderWithTenants(undefined, () =>
      Promise.reject(new Error("network")),
    );
    await waitFor(() => expect(result.current).toBe(true));
  });
});
