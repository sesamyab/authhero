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
      scope: "openid email profile",
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

async function exchangeCode(oauthApp: any, env: any, redirect: string) {
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
  const body = (await res.json()) as { id_token: string };
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
