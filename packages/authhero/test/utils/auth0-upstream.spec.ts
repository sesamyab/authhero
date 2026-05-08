import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auth0UpstreamError,
  fetchUserInfo,
  passwordRealmGrant,
  proxyRefreshToken,
} from "../../src/utils/auth0-upstream";

const TOKEN_ENDPOINT = "https://example.auth0.com/oauth/token";
const USERINFO_ENDPOINT = "https://example.auth0.com/userinfo";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("auth0-upstream", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("passwordRealmGrant", () => {
    it("posts password-realm grant with the expected body and returns tokens", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          access_token: "at",
          id_token: "it",
          refresh_token: "rt",
          expires_in: 86400,
          token_type: "Bearer",
          scope: "openid profile email",
        }),
      );

      const result = await passwordRealmGrant({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "cid",
        clientSecret: "csecret",
        realm: "Username-Password-Authentication",
        username: "user@example.com",
        password: "p4ssword",
      });

      expect(result).toEqual({
        access_token: "at",
        id_token: "it",
        refresh_token: "rt",
        expires_in: 86400,
        token_type: "Bearer",
        scope: "openid profile email",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(TOKEN_ENDPOINT);
      expect(init.method).toBe("POST");
      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe(
        "http://auth0.com/oauth/grant-type/password-realm",
      );
      expect(body.get("client_id")).toBe("cid");
      expect(body.get("client_secret")).toBe("csecret");
      expect(body.get("realm")).toBe("Username-Password-Authentication");
      expect(body.get("username")).toBe("user@example.com");
      expect(body.get("password")).toBe("p4ssword");
      expect(body.get("scope")).toBe("openid profile email");
    });

    it("throws Auth0UpstreamError carrying upstream error/code/description on 4xx", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(403, {
          error: "invalid_grant",
          error_description: "Wrong email or password.",
        }),
      );

      await expect(
        passwordRealmGrant({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          clientSecret: "csecret",
          realm: "Username-Password-Authentication",
          username: "user@example.com",
          password: "wrong",
        }),
      ).rejects.toMatchObject({
        name: "Auth0UpstreamError",
        status: 403,
        code: "invalid_grant",
        description: "Wrong email or password.",
      });
    });

    it("propagates mfa_required as Auth0UpstreamError", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(403, {
          error: "mfa_required",
          error_description: "Multifactor authentication required.",
          mfa_token: "mfa_xxx",
        }),
      );

      await expect(
        passwordRealmGrant({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          clientSecret: "csecret",
          realm: "Username-Password-Authentication",
          username: "user@example.com",
          password: "ok",
        }),
      ).rejects.toMatchObject({ code: "mfa_required" });
    });

    it("wraps fetch failure as Auth0UpstreamError(network_error)", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        passwordRealmGrant({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          clientSecret: "csecret",
          realm: "Username-Password-Authentication",
          username: "u",
          password: "p",
        }),
      ).rejects.toMatchObject({
        code: "network_error",
        status: 0,
      });
    });

    it("rejects malformed (non-JSON) success body", async () => {
      fetchSpy.mockResolvedValue(
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

      await expect(
        passwordRealmGrant({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          clientSecret: "csecret",
          realm: "Username-Password-Authentication",
          username: "u",
          password: "p",
        }),
      ).rejects.toBeInstanceOf(Auth0UpstreamError);
    });

    it("rejects success body missing access_token", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { id_token: "it" }));

      await expect(
        passwordRealmGrant({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          clientSecret: "csecret",
          realm: "Username-Password-Authentication",
          username: "u",
          password: "p",
        }),
      ).rejects.toMatchObject({ code: "malformed_response" });
    });
  });

  describe("fetchUserInfo", () => {
    it("sends bearer token and returns the profile", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          sub: "auth0|abc",
          email: "user@example.com",
          email_verified: true,
          name: "User",
        }),
      );

      const profile = await fetchUserInfo(USERINFO_ENDPOINT, "at");
      expect(profile.sub).toBe("auth0|abc");
      expect(profile.email).toBe("user@example.com");

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(USERINFO_ENDPOINT);
      expect(init.method).toBe("GET");
      expect(init.headers.authorization).toBe("Bearer at");
    });

    it("throws on missing sub", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, { email: "user@example.com" }),
      );
      await expect(fetchUserInfo(USERINFO_ENDPOINT, "at")).rejects.toMatchObject(
        { code: "malformed_response" },
      );
    });

    it("propagates non-2xx as Auth0UpstreamError", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(401, { error: "invalid_token" }),
      );
      await expect(fetchUserInfo(USERINFO_ENDPOINT, "bad")).rejects.toMatchObject(
        { status: 401, code: "invalid_token" },
      );
    });
  });

  describe("proxyRefreshToken", () => {
    it("posts refresh_token grant and returns the upstream status + body verbatim", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          access_token: "at2",
          refresh_token: "rt2",
          expires_in: 1234,
          token_type: "Bearer",
        }),
      );

      const result = await proxyRefreshToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "cid",
        clientSecret: "csecret",
        refreshToken: "rt-from-auth0",
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        access_token: "at2",
        refresh_token: "rt2",
        expires_in: 1234,
        token_type: "Bearer",
      });

      const [, init] = fetchSpy.mock.calls[0];
      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt-from-auth0");
      expect(body.get("client_id")).toBe("cid");
      expect(body.get("client_secret")).toBe("csecret");
    });

    it("returns upstream error body with original status (no exception on 4xx)", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(403, {
          error: "invalid_grant",
          error_description: "rotated",
        }),
      );

      const result = await proxyRefreshToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "cid",
        refreshToken: "stale",
      });

      expect(result.status).toBe(403);
      expect(result.body).toEqual({
        error: "invalid_grant",
        error_description: "rotated",
      });
    });

    it("omits client_secret for public clients", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { access_token: "x" }));

      await proxyRefreshToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "public",
        refreshToken: "rt",
      });

      const [, init] = fetchSpy.mock.calls[0];
      const body = new URLSearchParams(init.body);
      expect(body.has("client_secret")).toBe(false);
    });

    it("wraps fetch errors as Auth0UpstreamError(network_error)", async () => {
      fetchSpy.mockRejectedValue(new Error("offline"));

      await expect(
        proxyRefreshToken({
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "cid",
          refreshToken: "rt",
        }),
      ).rejects.toMatchObject({ code: "network_error" });
    });
  });
});
