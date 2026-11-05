import { describe, it, expect } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
} from "@authhero/adapter-interfaces";
import { testClient } from "hono/testing";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import { generateTOTP } from "../../../src/utils/totp";
import { decodeBase32 } from "@authhero/adapter-interfaces";
import bcryptjs from "bcryptjs";
import { Strategy } from "@authhero/adapter-interfaces";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";
import { amrFromLoginSession } from "../../../src/authentication-flows/common";

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function decodeIdToken(idToken: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"),
  );
}

async function createAwaitingMfaSession(
  env: any,
  stateData: Record<string, unknown>,
) {
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 600000).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid email profile offline_access",
      response_type: AuthorizationResponseType.CODE,
      state: "state",
      nonce: "nonce",
    },
    user_id: "email|userId",
    state: LoginSessionState.AWAITING_MFA,
    state_data: JSON.stringify(stateData),
  });
  const session = await env.data.sessions.create("tenantId", {
    id: `session-${loginSession.id}`,
    login_session_id: loginSession.id,
    user_id: "email|userId",
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 600000).toISOString(),
    used_at: new Date().toISOString(),
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
    session_id: session.id,
  });
  return loginSession;
}

async function exchangeCodeFull(oauthApp: any, env: any, redirect: string) {
  const code = new URL(redirect).searchParams.get("code");
  if (!code) throw new Error(`no code in ${redirect}`);
  const res = await testClient(oauthApp, env).oauth.token.$post({
    form: {
      grant_type: "authorization_code",
      client_id: "clientId",
      client_secret: "clientSecret",
      code,
      redirect_uri: "https://example.com/callback",
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id_token: string; refresh_token?: string };
}

async function exchangeCode(oauthApp: any, env: any, redirect: string) {
  const body = await exchangeCodeFull(oauthApp, env, redirect);
  return decodeIdToken(body.id_token);
}

async function postForm(
  u2App: any,
  env: any,
  path: string,
  state: string,
  code: string,
) {
  return u2App.request(
    `${path}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code }).toString(),
    },
    env,
  );
}

describe("amr claim after MFA", () => {
  it("adds amr=[mfa] to the ID token after TOTP MFA", async () => {
    const { u2App, oauthApp, env } = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });
    const session = await createAwaitingMfaSession(env, {
      authenticationMethodId: enrollment.id,
    });

    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    const res = await postForm(
      u2App,
      env,
      "/mfa/totp-challenge",
      session.id,
      code,
    );
    expect(res.status).toBe(302);

    const stored = await env.data.loginSessions.get("tenantId", session.id);
    expect(JSON.parse(stored!.state_data!).mfa_method).toBe("totp");

    const claims = await exchangeCode(
      oauthApp,
      env,
      res.headers.get("location")!,
    );
    expect(claims.amr).toEqual(["mfa"]);
  });

  it("keeps amr=[mfa] on ID tokens from a refresh token after MFA", async () => {
    const { u2App, oauthApp, env } = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });
    const session = await createAwaitingMfaSession(env, {
      authenticationMethodId: enrollment.id,
    });
    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    const res = await postForm(
      u2App,
      env,
      "/mfa/totp-challenge",
      session.id,
      code,
    );
    expect(res.status).toBe(302);

    const first = await exchangeCodeFull(
      oauthApp,
      env,
      res.headers.get("location")!,
    );
    expect(first.refresh_token).toBeTypeOf("string");

    // Drop the login session's MFA flags so only the browser session can
    // vouch for the MFA on refresh.
    await env.data.loginSessions.update("tenantId", session.id, {
      state_data: "{}",
    });

    const refreshed = await testClient(oauthApp, env).oauth.token.$post({
      form: {
        grant_type: "refresh_token",
        client_id: "clientId",
        client_secret: "clientSecret",
        refresh_token: first.refresh_token!,
      },
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { id_token?: string };
    expect(body.id_token).toBeTypeOf("string");
    expect(decodeIdToken(body.id_token!).amr).toEqual(["mfa"]);

    // The browser session, not just the login session, remembers the MFA
    const stored = await env.data.sessions.get(
      "tenantId",
      `session-${session.id}`,
    );
    expect(stored?.authentication?.methods?.[0]?.name).toBe("mfa");
  });

  it("does not lend the session's MFA to a different user (impersonation)", async () => {
    const { u2App, oauthApp, env } = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });
    const session = await createAwaitingMfaSession(env, {
      authenticationMethodId: enrollment.id,
    });
    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    const res = await postForm(
      u2App,
      env,
      "/mfa/totp-challenge",
      session.id,
      code,
    );
    const first = await exchangeCodeFull(
      oauthApp,
      env,
      res.headers.get("location")!,
    );
    await env.data.loginSessions.update("tenantId", session.id, {
      state_data: "{}",
    });
    await env.data.users.create("tenantId", {
      user_id: "email|someoneElse",
      email: "else@example.com",
      email_verified: true,
      connection: "email",
      provider: "email",
      is_social: false,
    });
    // The session now belongs to another user while still holding the
    // original user's MFA entry
    await env.data.sessions.update("tenantId", `session-${session.id}`, {
      user_id: "email|someoneElse",
    });

    const refreshed = await testClient(oauthApp, env).oauth.token.$post({
      form: {
        grant_type: "refresh_token",
        client_id: "clientId",
        client_secret: "clientSecret",
        refresh_token: first.refresh_token!,
      },
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { id_token?: string };
    expect(decodeIdToken(body.id_token!)).not.toHaveProperty("amr");
  });

  it("adds amr=[mfa] to the ID token after SMS MFA", async () => {
    const { u2App, oauthApp, env } = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    const enrollment = await env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "phone",
      phone_number: "+1234567890",
      confirmed: true,
    });
    const session = await createAwaitingMfaSession(env, {
      authenticationMethodId: enrollment.id,
    });
    await env.data.codes.create("tenantId", {
      code_id: `mfa:${session.id}`,
      code_type: "mfa_otp",
      login_id: session.id,
      otp: "123456",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    const res = await postForm(
      u2App,
      env,
      "/mfa/phone-challenge",
      session.id,
      "123456",
    );
    expect(res.status).toBe(302);

    const stored = await env.data.loginSessions.get("tenantId", session.id);
    expect(JSON.parse(stored!.state_data!).mfa_method).toBe("phone");

    const claims = await exchangeCode(
      oauthApp,
      env,
      res.headers.get("location")!,
    );
    expect(claims.amr).toEqual(["mfa"]);
  });

  it("omits amr when no MFA was performed", async () => {
    const { oauthApp, env } = await getTestServer({
      mockEmail: true,
      testTenantLanguage: "en",
    });
    const oauthClient = testClient(oauthApp, env);
    await env.data.users.create("tenantId", {
      email: "pw@example.com",
      email_verified: true,
      name: "Pw User",
      nickname: "Pw User",
      connection: Strategy.USERNAME_PASSWORD,
      provider: USERNAME_PASSWORD_PROVIDER,
      is_social: false,
      user_id: `${USERNAME_PASSWORD_PROVIDER}|pwUser`,
    });
    await env.data.passwords.create("tenantId", {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|pwUser`,
      password: await bcryptjs.hash("Test1234!", 10),
      algorithm: "bcrypt",
    });
    const co = await oauthClient.co.authenticate.$post({
      json: {
        client_id: "clientId",
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: Strategy.USERNAME_PASSWORD,
        password: "Test1234!",
        username: "pw@example.com",
      },
    });
    expect(co.status).toBe(200);
    const { login_ticket } = (await co.json()) as { login_ticket: string };
    const authorize = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket,
        realm: Strategy.USERNAME_PASSWORD,
        response_type: "code",
        redirect_uri: "https://example.com/callback",
        scope: "openid profile email",
        state: "state",
        nonce: "nonce",
      },
    });
    expect(authorize.status).toBe(302);

    const claims = await exchangeCode(
      oauthApp,
      env,
      authorize.headers.get("location")!,
    );
    expect(claims.sub).toBeTypeOf("string");
    expect(claims).not.toHaveProperty("amr");
  });

  it("amrFromLoginSession ignores mfa_verified without a recorded method", () => {
    expect(
      amrFromLoginSession({
        state_data: JSON.stringify({ mfa_verified: true }),
      } as any),
    ).toBeUndefined();
    expect(
      amrFromLoginSession({
        state_data: JSON.stringify({
          mfa_verified: true,
          mfa_method: "phone",
        }),
      } as any),
    ).toEqual(["mfa"]);
  });
});
