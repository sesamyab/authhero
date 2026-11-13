import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useHasReadyTenant } from "./tenant-switcher";

vi.mock("@/utils/domainUtils", () => ({
  formatDomain: (d: string) => d,
  getSelectedDomainFromStorage: () => "auth.example.com",
  getDomainFromStorage: () => [
    { url: "auth.example.com", connectionMethod: "token", token: "t" },
  ],
}));
vi.mock("@/dataProvider", () => ({
  resolveApiBase: () => "https://auth.example.com",
}));
vi.mock("@/authProvider", () => ({ createAuth0Client: vi.fn() }));
vi.mock("@/utils/tokenUtils", () => ({
  default: vi.fn(() => Promise.resolve("token")),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function answer(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 403,
    json: () => Promise.resolve(body),
  });
}

describe("useHasReadyTenant", () => {
  it("is false for a user who sees no tenant", async () => {
    answer({ tenants: [], start: 0, limit: 1, length: 0 });
    const { result } = renderHook(() => useHasReadyTenant(undefined));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is true when there is a tenant to switch to", async () => {
    answer({
      tenants: [
        { id: "acme", provisioning_state: "pending" },
        { id: "legacy" }, // From before provisioning states: ready.
      ],
      start: 0,
      limit: 50,
      length: 2,
    });
    const { result } = renderHook(() => useHasReadyTenant(undefined));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false while the only tenants are being set up or failed", async () => {
    answer({
      tenants: [
        { id: "acme", provisioning_state: "pending" },
        { id: "acme-eu", provisioning_state: "failed" },
      ],
      start: 0,
      limit: 50,
      length: 2,
    });
    const { result } = renderHook(() => useHasReadyTenant(undefined));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is true inside a tenant without asking", () => {
    const { result } = renderHook(() => useHasReadyTenant("acme"));
    expect(result.current).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the navigation when the question fails", async () => {
    answer({}, false);
    const { result } = renderHook(() => useHasReadyTenant(undefined));
    await waitFor(() => expect(result.current).toBe(true));
  });
});
