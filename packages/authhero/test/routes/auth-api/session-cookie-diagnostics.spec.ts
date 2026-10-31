import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
  LogTypes,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";

type Env = Awaited<ReturnType<typeof getTestServer>>["env"];

async function createSession(
  env: Env,
  id: string,
  user_id = "email|userId",
  authenticated_at?: string,
) {
  const session = await env.data.sessions.create("tenantId", {
    id,
    user_id,
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
  if (authenticated_at) {
    await env.data.sessions.update("tenantId", id, { authenticated_at });
  }
  return session;
}

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

    await createSession(env, "sid_valid");

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

  it("uses the most recently authenticated session when the jars disagree", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);
    await env.data.users.create("tenantId", {
      user_id: "email|newerUser",
      email: "newer@example.com",
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
    });
    await createSession(
      env,
      "sid_older",
      "email|userId",
      new Date(Date.now() - 3600_000).toISOString(),
    );
    await createSession(
      env,
      "sid_newer",
      "email|newerUser",
      new Date().toISOString(),
    );

    // The older session first: cookie order must not decide.
    const response = await oauthClient.authorize.$get(
      { query: authorizeQuery },
      {
        headers: {
          cookie:
            "tenantId-auth-token=sid_older; tenantId-auth-token=sid_newer",
        },
      },
    );

    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    );
    const stored = await env.data.codes.get(
      "tenantId",
      code!,
      "authorization_code",
    );
    expect(stored?.user_id).toBe("email|newerUser");
  });

  it("skips an expired session even when it is the most recent", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);
    await createSession(
      env,
      "sid_live",
      "email|userId",
      new Date(Date.now() - 3600_000).toISOString(),
    );
    await createSession(
      env,
      "sid_expired",
      "email|userId",
      new Date().toISOString(),
    );
    await env.data.sessions.update("tenantId", "sid_expired", {
      idle_expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const response = await oauthClient.authorize.$get(
      { query: { ...authorizeQuery, prompt: "none" } },
      {
        headers: {
          cookie:
            "tenantId-auth-token=sid_expired; tenantId-auth-token=sid_live",
        },
      },
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");
  });

  it("revokes every session the browser sent on logout", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);
    await createSession(env, "sid_a");
    await createSession(env, "sid_b");

    const response = await oauthClient.v2.logout.$get(
      {
        query: {
          client_id: "clientId",
          returnTo: "https://example.com/callback",
        },
      },
      {
        headers: {
          cookie: "tenantId-auth-token=sid_a; tenantId-auth-token=sid_b",
        },
      },
    );

    expect(response.status).toBe(302);
    for (const id of ["sid_a", "sid_b"]) {
      const session = await env.data.sessions.get("tenantId", id);
      expect(session?.revoked_at).toBeTruthy();
    }
  });

  it("records the snapshot when /authorize goes straight to a connection", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.authorize.$get(
      { query: { ...authorizeQuery, connection: "mock-strategy" } },
      { headers: { cookie: "other=x", "sec-fetch-site": "cross-site" } },
    );

    expect(response.status).toBe(302);
    // The mock strategy always issues the provider state "code".
    const code = await env.data.codes.get("tenantId", "code", "oauth2_state");
    const loginSession = await env.data.loginSessions.get(
      "tenantId",
      code!.login_id,
    );
    expect(JSON.parse(loginSession!.state_data!).session_cookie).toMatchObject({
      received: 0,
      result: "none",
      cookies: 1,
      fetch_site: "cross-site",
    });
  });
});
