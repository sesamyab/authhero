// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DOMAINS_STORAGE_KEY,
  SELECTED_DOMAIN_STORAGE_KEY,
  type DomainConfig,
} from "./utils/domainUtils";

// The client reaches for browser auth state; stub the token helpers and the
// Auth0 SDK so only the response handling is exercised.
vi.mock("./utils/tokenUtils", () => ({
  default: vi.fn(async () => "test-token"),
  clearOrganizationTokenCache: vi.fn(),
  recoverFromTokenError: vi.fn(),
  getOrganizationToken: vi.fn(),
  getOrgAccessToken: vi.fn(),
}));

vi.mock("@auth0/auth0-spa-js", () => ({
  Auth0Client: vi.fn(function () {
    return {
      loginWithRedirect: vi.fn(),
      handleRedirectCallback: vi.fn(),
      getTokenSilently: vi.fn(),
      isAuthenticated: vi.fn(),
      logout: vi.fn(),
    };
  }),
}));

import { authorizedHttpClient } from "./authProvider";

const DOMAIN = "auth.example.com";

/**
 * Stores one signed-in domain and selects it, the way the domain selector
 * does, so `authorizedHttpClient` finds a config for the request.
 */
function useDomain(config: Partial<DomainConfig>) {
  const entry: DomainConfig = {
    url: DOMAIN,
    clientId: "default",
    connectionMethod: "login",
    ...config,
  };
  localStorage.setItem(DOMAINS_STORAGE_KEY, JSON.stringify([entry]));
  localStorage.setItem(SELECTED_DOMAIN_STORAGE_KEY, DOMAIN);
}

/** Makes every `fetch` answer with the given status and body text. */
function answerWith(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, { status, statusText: `status ${status}` }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  window.__AUTHHERO_ADMIN_CONFIG__ = { domain: "", clientId: "", apiUrl: "" };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizedHttpClient errors", () => {
  // Each way of signing in has its own response handling, so both are checked.
  it.each([
    ["a stored token", { connectionMethod: "token", token: "t" } as const],
    ["a login", { connectionMethod: "login" } as const],
  ])("keeps the HTTP status of a refused call (%s)", async (_label, config) => {
    useDomain(config);

    for (const status of [403, 404, 405]) {
      answerWith(status, '{"message":"no"}');
      const failure = await authorizedHttpClient(
        `https://${DOMAIN}/api/v2/tenants/acme?status=${status}`,
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { httpStatus?: number }).httpStatus).toBe(status);
    }
  });

  it("does not set `status`, so react-admin does not sign the user out on a 403", async () => {
    useDomain({ connectionMethod: "login" });
    answerWith(403, '{"message":"no"}');

    const failure = await authorizedHttpClient(
      `https://${DOMAIN}/api/v2/tenants/acme`,
    ).catch((error: unknown) => error);

    // `checkError` signs out on `status` 401 or 403.
    expect(failure).not.toHaveProperty("status");
  });

  it("still returns the parsed body on success", async () => {
    useDomain({ connectionMethod: "login" });
    answerWith(200, '{"ok":true}');

    const res = await authorizedHttpClient(
      `https://${DOMAIN}/api/v2/tenants/acme/ok`,
    );

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });
});
