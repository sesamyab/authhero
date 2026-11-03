import { describe, it, expect } from "vitest";
import {
  clearAuthCookie,
  getAllAuthCookies,
  getPrivateBrowsingCookie,
  getSessionCookieDiagnostics,
  serializeAuthCookie,
} from "../../src/utils/cookies";

function headersFrom(values: Record<string, string>) {
  return { header: (name: string) => values[name] };
}

describe("serializeAuthCookie", () => {
  it("sets the session both non-partitioned and partitioned in production", () => {
    const cookies = serializeAuthCookie(
      "tenantId",
      "sid_1",
      "login.example.com",
    );

    expect(cookies).toEqual([
      "tenantId-auth-token=sid_1; Max-Age=2592000; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=None",
      "tenantId-auth-token=sid_1; Max-Age=2592000; Domain=.example.com; Path=/; HttpOnly; Secure; Partitioned; SameSite=None",
    ]);
  });

  it("sets a single non-partitioned Lax cookie on insecure dev hosts", () => {
    const cookies = serializeAuthCookie("tenantId", "sid_1", "localhost:3000");

    expect(cookies).toEqual([
      "tenantId-auth-token=sid_1; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });
});

describe("clearAuthCookie", () => {
  it("clears both variants in production", () => {
    const cookies = clearAuthCookie("tenantId", "login.example.com");

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).not.toContain("Partitioned");
    expect(cookies[1]).toContain("Partitioned");
    for (const cookie of cookies) {
      expect(cookie).toContain("tenantId-auth-token=; Max-Age=0");
    }
  });
});

describe("getAllAuthCookies", () => {
  it("returns the value from each jar", () => {
    expect(
      getAllAuthCookies(
        "tenantId",
        "tenantId-auth-token=sid_1; other=x; tenantId-auth-token=sid_2",
      ),
    ).toEqual(["sid_1", "sid_2"]);
  });
});

describe("getSessionCookieDiagnostics", () => {
  it("records what the browser sent without cookie values or full URLs", () => {
    const diagnostics = getSessionCookieDiagnostics(
      "tenantId",
      headersFrom({
        cookie:
          "tenantId-last-used-connection=email; tenantId-auth-token=sid_1; other=x",
        "sec-fetch-site": "cross-site",
        "sec-fetch-dest": "document",
        referer: "https://reader.vendor.example/issue/123?token=secret",
      }),
      1,
      "not_found",
    );

    expect(diagnostics).toEqual({
      received: 1,
      result: "not_found",
      cookies: 3,
      last_used: true,
      fetch_site: "cross-site",
      fetch_dest: "document",
      storage_access: undefined,
      referrer: "reader.vendor.example",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("sid_1");
  });

  it("handles a request without cookies or referer", () => {
    expect(
      getSessionCookieDiagnostics("tenantId", headersFrom({}), 0, "none"),
    ).toMatchObject({
      received: 0,
      result: "none",
      cookies: 0,
      last_used: false,
    });
  });
});

describe("getPrivateBrowsingCookie", () => {
  it("reads the flag reported by the login page", () => {
    expect(getPrivateBrowsingCookie("authhero-private-browsing=1")).toBe(true);
    expect(getPrivateBrowsingCookie("authhero-private-browsing=0")).toBe(false);
    expect(getPrivateBrowsingCookie("other=1")).toBeUndefined();
    expect(getPrivateBrowsingCookie(undefined)).toBeUndefined();
  });
});
