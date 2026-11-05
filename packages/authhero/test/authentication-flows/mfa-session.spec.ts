import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
  LoginSessionState,
  decodeBase32,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { generateTOTP } from "../../src/utils/totp";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;
type TestEnv = TestServer["env"];

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const USER_ID = "email|userId";

async function enableTotpMfa(env: TestEnv) {
  const tenant = await env.data.tenants.get("tenantId");
  await env.data.tenants.update("tenantId", {
    mfa: {
      ...tenant?.mfa,
      policy: "always",
      factors: { ...tenant?.mfa?.factors, otp: true },
    },
  });
}

async function enrollTotp(env: TestEnv) {
  await env.data.authenticationMethods.create("tenantId", {
    user_id: USER_ID,
    type: "totp",
    totp_secret: TOTP_SECRET,
    confirmed: true,
  });
}

async function createSecondClient(env: TestEnv) {
  await env.data.clients.create("tenantId", {
    client_id: "clientId2",
    client_secret: "clientSecret2",
    name: "Second Client",
    callbacks: ["https://second.example.com/callback"],
    web_origins: ["https://second.example.com"],
    client_metadata: { email_validation: "disabled" },
  });
}

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

/**
 * Put the first client's login in the state the first factor leaves it in:
 * a browser session exists and the login session waits for MFA.
 */
async function seedLoginAwaitingMfa(env: TestEnv) {
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid",
      response_type: AuthorizationResponseType.CODE,
      state: "state",
      nonce: "nonce",
    },
  });
  const session = await env.data.sessions.create("tenantId", {
    id: `session-${loginSession.id}`,
    user_id: USER_ID,
    login_session_id: loginSession.id,
    device,
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    idle_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  await env.data.loginSessions.update("tenantId", loginSession.id, {
    user_id: USER_ID,
    session_id: session.id,
    state: LoginSessionState.AWAITING_MFA,
  });
  return { loginSession, session };
}

async function completeTotpChallenge(server: TestServer, state: string) {
  const code = await generateTOTP(decodeBase32(TOTP_SECRET));
  return server.u2App.request(
    `/mfa/totp-challenge?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code }).toString(),
    },
    server.env,
  );
}

describe("MFA completion on the session (#1668)", () => {
  it("records the MFA method on the session when the challenge succeeds", async () => {
    const server = await getTestServer({ testTenantLanguage: "en" });
    const { env } = server;
    await enableTotpMfa(env);
    await enrollTotp(env);
    const { loginSession, session } = await seedLoginAwaitingMfa(env);

    const response = await completeTotpChallenge(server, loginSession.id);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://example.com/callback",
    );

    const stored = await env.data.sessions.get("tenantId", session.id);
    const methods = stored?.authentication?.methods ?? [];
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ name: "mfa", type: "totp" });
    expect(Date.parse(methods[0]!.timestamp)).not.toBeNaN();
  });

  it("does not re-prompt MFA when a second client SSOs on a session that completed MFA", async () => {
    const server = await getTestServer({ testTenantLanguage: "en" });
    const { env, oauthApp } = server;
    await enableTotpMfa(env);
    await enrollTotp(env);
    await createSecondClient(env);
    const { loginSession, session } = await seedLoginAwaitingMfa(env);

    const mfaResponse = await completeTotpChallenge(server, loginSession.id);
    expect(mfaResponse.status).toBe(302);

    const oauthClient = testClient(oauthApp, env);
    const ssoResponse = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId2",
          redirect_uri: "https://second.example.com/callback",
          state: "state2",
          nonce: "nonce2",
          scope: "openid",
          response_type: AuthorizationResponseType.CODE,
        },
      },
      { headers: { cookie: `tenantId-auth-token=${session.id}` } },
    );

    expect(ssoResponse.status).toBe(302);
    const location = ssoResponse.headers.get("location") ?? "";
    expect(location).not.toContain("/mfa/");
    const redirect = new URL(location);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://second.example.com/callback",
    );
    expect(redirect.searchParams.get("code")).toBeTruthy();
  });

  it("still prompts MFA on SSO when the session never completed MFA", async () => {
    const server = await getTestServer({ testTenantLanguage: "en" });
    const { env, oauthApp } = server;
    await enrollTotp(env);
    await createSecondClient(env);

    // A session from before the tenant enabled MFA.
    const session = await env.data.sessions.create("tenantId", {
      id: "preMfaSession",
      user_id: USER_ID,
      login_session_id: "oldLoginSession",
      device,
      clients: ["clientId"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      idle_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await enableTotpMfa(env);

    const oauthClient = testClient(oauthApp, env);
    const ssoResponse = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId2",
          redirect_uri: "https://second.example.com/callback",
          state: "state2",
          nonce: "nonce2",
          scope: "openid",
          response_type: AuthorizationResponseType.CODE,
        },
      },
      { headers: { cookie: `tenantId-auth-token=${session.id}` } },
    );

    expect(ssoResponse.status).toBe(302);
    expect(ssoResponse.headers.get("location")).toContain(
      "/u2/mfa/totp-challenge",
    );
  });

  it("refuses silent auth with interaction_required for a session from before MFA was enabled", async () => {
    const server = await getTestServer({ testTenantLanguage: "en" });
    const { env, oauthApp } = server;
    await enrollTotp(env);

    const session = await env.data.sessions.create("tenantId", {
      id: "preMfaSession",
      user_id: USER_ID,
      login_session_id: "oldLoginSession",
      device,
      clients: ["clientId"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      idle_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await enableTotpMfa(env);

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          prompt: "none",
          response_type: AuthorizationResponseType.CODE,
          response_mode: AuthorizationResponseMode.WEB_MESSAGE,
        },
      },
      {
        headers: {
          origin: "https://example.com",
          cookie: `tenantId-auth-token=${session.id}`,
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("interaction_required");
    expect(body).not.toContain('"code"');
  });

  it("allows silent auth once the session has completed MFA", async () => {
    const server = await getTestServer({ testTenantLanguage: "en" });
    const { env, oauthApp } = server;
    await enableTotpMfa(env);
    await enrollTotp(env);
    const { loginSession, session } = await seedLoginAwaitingMfa(env);

    const mfaResponse = await completeTotpChallenge(server, loginSession.id);
    expect(mfaResponse.status).toBe(302);

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          prompt: "none",
          response_type: AuthorizationResponseType.CODE,
          response_mode: AuthorizationResponseMode.WEB_MESSAGE,
        },
      },
      {
        headers: {
          origin: "https://example.com",
          cookie: `tenantId-auth-token=${session.id}`,
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/"code":"[^"]+"/);
  });
});
