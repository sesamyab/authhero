import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
  LogTypes,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";

const authorizeQuery = {
  client_id: "clientId",
  redirect_uri: "https://example.com/callback",
  state: "state",
  nonce: "nonce",
  scope: "openid email profile",
  response_type: AuthorizationResponseType.CODE,
  response_mode: AuthorizationResponseMode.QUERY,
};

describe("session cookie diagnostics on the login log", () => {
  it("records what /authorize received and the private-browsing probe", async () => {
    const { universalApp, oauthApp, env, getSentEmails } =
      await getTestServer();
    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);

    // A stale session cookie plus the Lax last-used cookie, arriving through
    // a cross-site redirect: the shape of the Safari report in #1639.
    const authorizeResponse = await oauthClient.authorize.$get(
      { query: authorizeQuery },
      {
        headers: {
          cookie:
            "tenantId-auth-token=sid_unknown; tenantId-last-used-connection=email",
          "sec-fetch-site": "cross-site",
          "sec-fetch-dest": "document",
          referer: "https://reader.vendor.example/issue/1?token=secret",
        },
      },
    );
    expect(authorizeResponse.status).toBe(302);
    const state = new URL(
      authorizeResponse.headers.get("location")!,
      "https://example.com",
    ).searchParams.get("state")!;

    await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "foo@example.com" },
    });
    const { code } = getSentEmails()[0].data;
    const loginResponse = await universalClient.login[
      "email-otp-challenge"
    ].$post(
      { query: { state }, form: { code } },
      { headers: { cookie: "authhero-private-browsing=0" } },
    );
    expect(loginResponse.status).toBe(302);

    const { logs } = await env.data.logs.list("tenantId", {
      page: 0,
      per_page: 100,
      include_totals: true,
    });
    const successLog = logs.find((log) => log.type === LogTypes.SUCCESS_LOGIN);

    expect(successLog?.details).toMatchObject({
      request: { method: "POST" },
      session_cookie: {
        received: 1,
        result: "not_found",
        cookies: 2,
        last_used: true,
        fetch_site: "cross-site",
        fetch_dest: "document",
        referrer: "reader.vendor.example",
      },
      private_browsing: false,
    });
    expect(JSON.stringify(successLog?.details)).not.toContain("sid_unknown");
  });

  it("finds the session from the non-partitioned cookie alone", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);

    await env.data.sessions.create("tenantId", {
      id: "sid_valid",
      user_id: "email|userId",
      clients: ["clientId"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      used_at: new Date().toISOString(),
      login_session_id: "",
      device: {
        last_ip: "",
        initial_ip: "",
        last_user_agent: "",
        initial_user_agent: "",
        initial_asn: "",
        last_asn: "",
      },
    });

    // The Cookie header can't say which jar a value came from; a single
    // value is what a browser sends when only one of the two is present.
    const response = await oauthClient.authorize.$get(
      { query: authorizeQuery },
      { headers: { cookie: "tenantId-auth-token=sid_valid" } },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://example.com/callback",
    );
    expect(location.searchParams.get("code")).toBeTruthy();
  });
});
