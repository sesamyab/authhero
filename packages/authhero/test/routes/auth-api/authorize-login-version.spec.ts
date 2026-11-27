import { describe, expect, it } from "vitest";
import { testClient } from "hono/testing";
import { AuthorizationResponseType } from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";

describe("universal login version selection (#1741)", () => {
  it.each([
    ["2", undefined, "/u2/"],
    [undefined, undefined, "/u/"],
    ["1", undefined, "/u/"],
    ["2", "1", "/u/"],
    [undefined, "2", "/u2/"],
  ] as const)(
    "tenant flag %s with client override %s redirects to %s",
    async (tenantVersion, override, prefix) => {
      const { oauthApp, env } = await getTestServer();
      await env.data.tenants.update("tenantId", {
        flags: tenantVersion ? { universal_login_version: tenantVersion } : {},
      });
      await env.data.clients.update("tenantId", "clientId", {
        client_metadata: override ? { universal_login_version: override } : {},
      });

      const response = await testClient(oauthApp, env).authorize.$get({
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          response_type: AuthorizationResponseType.CODE,
          state: "state",
          scope: "openid",
        },
      });

      expect(response.status).toBe(302);
      const location = new URL(
        response.headers.get("location")!,
        "https://example.com",
      );
      expect(location.pathname.startsWith(prefix)).toBe(true);
    },
  );
});
