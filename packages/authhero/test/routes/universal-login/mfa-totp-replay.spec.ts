import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
  decodeBase32,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import { generateTOTP } from "../../../src/utils/totp";

/**
 * Issue #1666: a TOTP code that has been accepted once must be rejected when
 * it is submitted again within its validity window (RFC 6238 §5.2).
 */

type TestServer = Awaited<ReturnType<typeof getTestServer>>;
type TestEnv = TestServer["env"];

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

async function enableTotpMfa(server: TestServer) {
  const token = await getAdminToken();
  const headers = {
    "tenant-id": "tenantId",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  await server.managementApp.request(
    "/guardian/factors/otp",
    { method: "PUT", headers, body: JSON.stringify({ enabled: true }) },
    server.env,
  );
  await server.managementApp.request(
    "/guardian/policies",
    {
      method: "PUT",
      headers,
      body: JSON.stringify(["all-applications"]),
    },
    server.env,
  );
}

let sessionCounter = 0;

async function createMfaLoginSession(
  env: TestEnv,
  stateData?: Record<string, unknown>,
) {
  // Completing the auth flow after MFA needs a session on the login session.
  const sessionId = `totp-replay-session-${++sessionCounter}`;
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 600000).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid email profile",
      response_type: AuthorizationResponseType.CODE,
      state: "state",
      nonce: "nonce",
    },
    user_id: "email|userId",
    state: LoginSessionState.AWAITING_MFA,
    ...(stateData ? { state_data: JSON.stringify(stateData) } : {}),
  });
  await env.data.sessions.create("tenantId", {
    id: sessionId,
    user_id: "email|userId",
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    used_at: new Date().toISOString(),
    login_session_id: loginSession.id,
    device: {
      last_ip: "",
      initial_ip: "",
      last_user_agent: "",
      initial_user_agent: "",
      initial_asn: "",
      last_asn: "",
    },
  });
  await env.data.loginSessions.update("tenantId", loginSession.id, {
    session_id: sessionId,
  });
  return loginSession;
}

async function postCode(
  server: TestServer,
  path: string,
  state: string,
  code: string,
  extraHeaders: Record<string, string> = {},
) {
  return server.u2App.request(
    `${path}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
      body: new URLSearchParams({ code }).toString(),
    },
    server.env,
  );
}

async function expectInvalidCode(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("The code you entered is invalid");
}

// Pin the clock so every code in a test falls in one 30-second window.
function freezeClock() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  return now;
}

describe("TOTP replay protection (#1666)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a challenge code that already succeeded once in the same window", async () => {
    const server = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    await enableTotpMfa(server);
    const { env } = server;

    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });

    const now = freezeClock();
    const code = await generateTOTP(decodeBase32(TOTP_SECRET));

    const first = await createMfaLoginSession(env, {
      authenticationMethodId: enrollment.id,
    });
    const firstResponse = await postCode(
      server,
      "/mfa/totp-challenge",
      first.id,
      code,
    );
    expect(firstResponse.status).toBe(302);
    expect(firstResponse.headers.get("location")).toContain(
      "example.com/callback",
    );
    expect(
      (await env.data.authenticationMethods.get("tenantId", enrollment.id))
        ?.totp_last_step,
    ).toBe(Math.floor(now / 30_000));

    // Same code, new login (e.g. an attacker who phished it), same window.
    const second = await createMfaLoginSession(env, {
      authenticationMethodId: enrollment.id,
    });
    const secondResponse = await postCode(
      server,
      "/mfa/totp-challenge",
      second.id,
      code,
    );
    await expectInvalidCode(secondResponse);
    const secondSession = await env.data.loginSessions.get(
      "tenantId",
      second.id,
    );
    const secondState = secondSession?.state_data
      ? JSON.parse(secondSession.state_data)
      : {};
    expect(secondState.mfa_verified).toBeFalsy();

    // The code from the next window is still accepted.
    vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
    const nextCode = await generateTOTP(decodeBase32(TOTP_SECRET));
    const third = await createMfaLoginSession(env, {
      authenticationMethodId: enrollment.id,
    });
    const thirdResponse = await postCode(
      server,
      "/mfa/totp-challenge",
      third.id,
      nextCode,
    );
    expect(thirdResponse.status).toBe(302);
  });

  it("rejects an earlier-window code once a later one was accepted", async () => {
    const server = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    await enableTotpMfa(server);
    const { env } = server;

    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });

    const now = freezeClock();
    const previousCode = await generateTOTP(decodeBase32(TOTP_SECRET));
    vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
    const currentCode = await generateTOTP(decodeBase32(TOTP_SECRET));

    const first = await createMfaLoginSession(env);
    expect(
      (await postCode(server, "/mfa/totp-challenge", first.id, currentCode))
        .status,
    ).toBe(302);

    // The previous window's code is still inside the ±1 tolerance, but its
    // step is below the accepted one.
    const second = await createMfaLoginSession(env);
    await expectInvalidCode(
      await postCode(server, "/mfa/totp-challenge", second.id, previousCode),
    );
  });

  it("rejects resubmitting the login enrollment code, on the enrollment and on the challenge", async () => {
    const server = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    await enableTotpMfa(server);
    const { env, u2App } = server;

    const loginSession = await createMfaLoginSession(env);
    await u2App.request(
      `/mfa/totp-enrollment?state=${encodeURIComponent(loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      env,
    );
    const [enrollment] = await env.data.authenticationMethods.list(
      "tenantId",
      "email|userId",
    );
    expect(enrollment?.totp_secret).toBeTruthy();

    freezeClock();
    const code = await generateTOTP(decodeBase32(enrollment!.totp_secret!));

    const enrollResponse = await postCode(
      server,
      "/mfa/totp-enrollment",
      loginSession.id,
      code,
    );
    expect(enrollResponse.status).toBe(302);
    expect(enrollResponse.headers.get("location")).toContain(
      "/mfa/totp-challenge",
    );

    // Resubmitting the enrollment form with the same code is rejected.
    const resubmit = await postCode(
      server,
      "/mfa/totp-enrollment",
      loginSession.id,
      code,
    );
    await expectInvalidCode(resubmit);

    // So is using the enrollment code on the challenge that follows.
    const challenge = await postCode(
      server,
      "/mfa/totp-challenge",
      loginSession.id,
      code,
    );
    await expectInvalidCode(challenge);
  });

  it("records the account-security enrollment code so the login challenge rejects it", async () => {
    const server = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    await enableTotpMfa(server);
    const { env, u2App } = server;

    const accountLoginSession = await env.data.loginSessions.create(
      "tenantId",
      {
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        csrf_token: "csrf",
        authParams: { client_id: "clientId" },
      },
    );
    await env.data.sessions.create("tenantId", {
      id: "totp-replay-account-session",
      user_id: "email|userId",
      clients: ["clientId"],
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      used_at: new Date().toISOString(),
      login_session_id: accountLoginSession.id,
      device: {
        last_ip: "",
        initial_ip: "",
        last_user_agent: "",
        initial_user_agent: "",
        initial_asn: "",
        last_asn: "",
      },
    });
    const cookie = {
      cookie: "tenantId-auth-token=totp-replay-account-session",
    };

    const getResponse = await u2App.request(
      `/account/security/totp-enrollment?state=${encodeURIComponent(accountLoginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId", ...cookie } },
      env,
    );
    expect(getResponse.status).toBe(200);

    const stored = await env.data.loginSessions.get(
      "tenantId",
      accountLoginSession.id,
    );
    const secret = JSON.parse(stored!.state_data!).totpSecret as string;
    expect(secret).toBeTruthy();

    const now = freezeClock();
    const code = await generateTOTP(decodeBase32(secret));

    const enrollResponse = await postCode(
      server,
      "/account/security/totp-enrollment",
      accountLoginSession.id,
      code,
      cookie,
    );
    expect(enrollResponse.status).toBe(302);
    expect(enrollResponse.headers.get("location")).toContain(
      "/account/security",
    );

    const methods = await env.data.authenticationMethods.list(
      "tenantId",
      "email|userId",
    );
    const totp = methods.find((m) => m.type === "totp");
    expect(totp?.confirmed).toBe(true);
    expect(totp?.totp_last_step).toBe(Math.floor(now / 30_000));

    // The same code cannot then be used to pass a login MFA challenge.
    const mfaSession = await createMfaLoginSession(env);
    const challenge = await postCode(
      server,
      "/mfa/totp-challenge",
      mfaSession.id,
      code,
    );
    await expectInvalidCode(challenge);
  });
});
