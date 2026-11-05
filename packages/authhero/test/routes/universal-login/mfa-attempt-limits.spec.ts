import { describe, it, expect } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
  LogTypes,
  decodeBase32,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { generateTOTP } from "../../../src/utils/totp";
import { verifyTotpCode } from "../../../src/authentication-flows/mfa";
import {
  MFA_LOCKOUT_REASON,
  MFA_MAX_FAILED_ATTEMPTS,
  MFA_MAX_SMS_SENDS,
} from "../../../src/authentication-flows/mfa-attempts";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;
type TestEnv = TestServer["env"];

const USER_ID = "email|userId";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const formHeaders = {
  "tenant-id": "tenantId",
  "content-type": "application/x-www-form-urlencoded",
};

async function validTotp(secret = TOTP_SECRET) {
  return generateTOTP(decodeBase32(secret));
}

/** A 6-digit code rejected by the full (±1 step) verification window. */
async function wrongTotp(secret = TOTP_SECRET) {
  for (let candidate = 0; ; candidate++) {
    const code = String(candidate).padStart(6, "0");
    if (!(await verifyTotpCode(secret, code))) return code;
  }
}

async function createMfaSession(
  env: TestEnv,
  stateData: Record<string, unknown> = {},
) {
  return env.data.loginSessions.create("tenantId", {
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
    user_id: USER_ID,
    state: LoginSessionState.AWAITING_MFA,
    state_data: JSON.stringify(stateData),
  });
}

async function post(
  server: TestServer,
  path: string,
  state: string,
  body: Record<string, string>,
  headers: Record<string, string> = formHeaders,
) {
  return server.u2App.request(
    `${path}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams(body).toString(),
    },
    server.env,
  );
}

async function expectLockedOut(env: TestEnv, state: string) {
  const session = await env.data.loginSessions.get("tenantId", state);
  expect(session?.state).toBe(LoginSessionState.FAILED);
  expect(session?.failure_reason).toBe(MFA_LOCKOUT_REASON);

  const { logs } = await env.data.logs.list("tenantId", {
    q: `type:${LogTypes.TOO_MANY_MFA_FAILURES}`,
  });
  expect(logs.length).toBeGreaterThanOrEqual(1);
  expect(logs[0]?.user_id).toBe(USER_ID);
}

async function seedMfaSmsCode(env: TestEnv, loginSessionId: string) {
  await env.data.codes.create("tenantId", {
    code_id: `mfa:${loginSessionId}`,
    code_type: "mfa_otp",
    login_id: loginSessionId,
    otp: "123456",
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
}

const TOO_MANY = "maximum number of failed attempts";

describe("MFA failed-attempt limits", () => {
  describe("TOTP challenge", () => {
    it("fails the login session on the Nth bad code and rejects a correct code afterwards", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      const enrollment = await env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "totp",
          totp_secret: TOTP_SECRET,
          confirmed: true,
        },
      );
      const session = await createMfaSession(env, {
        authenticationMethodId: enrollment.id,
      });

      for (let i = 1; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
        const res = await post(server, "/mfa/totp-challenge", session.id, {
          code: await wrongTotp(),
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("The code you entered is invalid");
      }
      const stillOpen = await env.data.loginSessions.get(
        "tenantId",
        session.id,
      );
      expect(stillOpen?.state).toBe(LoginSessionState.AWAITING_MFA);

      const last = await post(server, "/mfa/totp-challenge", session.id, {
        code: await wrongTotp(),
      });
      expect(last.status).toBe(400);
      expect(await last.text()).toContain(TOO_MANY);
      await expectLockedOut(env, session.id);

      const correct = await post(server, "/mfa/totp-challenge", session.id, {
        code: await validTotp(),
      });
      expect(correct.status).toBe(400);
      expect(correct.headers.get("location")).toBeNull();
      expect(await correct.text()).toContain(TOO_MANY);
    });

    it("clears the counter when a correct code is entered before the limit", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      const enrollment = await env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "totp",
          totp_secret: TOTP_SECRET,
          confirmed: true,
        },
      );
      const session = await createMfaSession(env, {
        authenticationMethodId: enrollment.id,
      });

      for (let i = 0; i < MFA_MAX_FAILED_ATTEMPTS - 1; i++) {
        await post(server, "/mfa/totp-challenge", session.id, {
          code: await wrongTotp(),
        });
      }
      const res = await post(server, "/mfa/totp-challenge", session.id, {
        code: await validTotp(),
      });
      // The hand-made session has no auth session, so only the MFA step is
      // asserted here; the full redirect is covered in mfa-totp.spec.ts.
      expect(await res.text()).not.toContain(TOO_MANY);

      const updated = await env.data.loginSessions.get("tenantId", session.id);
      const data = JSON.parse(updated!.state_data!);
      expect(data.mfa_verified).toBe(true);
      expect(data.mfa_failed_attempts).toBeUndefined();
    });

    it("consumes the per-user rate limit and locks out when it denies, even for a correct code", async () => {
      const consumed: { scope: string; key: string }[] = [];
      const server = await getTestServer({
        testTenantLanguage: "en",
        rateLimit: {
          consume: async (scope, key) => {
            consumed.push({ scope, key });
            return { allowed: false };
          },
        },
      });
      const { env } = server;
      const enrollment = await env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "totp",
          totp_secret: TOTP_SECRET,
          confirmed: true,
        },
      );
      const session = await createMfaSession(env, {
        authenticationMethodId: enrollment.id,
      });

      const res = await post(server, "/mfa/totp-challenge", session.id, {
        code: await validTotp(),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(TOO_MANY);
      expect(consumed).toEqual([
        { scope: "brute-force", key: `mfa:tenantId:${USER_ID}` },
      ]);
      await expectLockedOut(env, session.id);
    });
  });

  describe("SMS challenge", () => {
    it("fails the login session on the Nth bad code and rejects a correct code afterwards", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      await env.data.authenticationMethods.create("tenantId", {
        user_id: USER_ID,
        type: "phone",
        phone_number: "+46701234567",
        confirmed: true,
      });
      const session = await createMfaSession(env);
      await seedMfaSmsCode(env, session.id);

      for (let i = 1; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
        const res = await post(server, "/mfa/phone-challenge", session.id, {
          code: "000000",
        });
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(TOO_MANY);
      }

      const last = await post(server, "/mfa/phone-challenge", session.id, {
        code: "000000",
      });
      expect(last.status).toBe(400);
      expect(await last.text()).toContain(TOO_MANY);
      await expectLockedOut(env, session.id);

      const correct = await post(server, "/mfa/phone-challenge", session.id, {
        code: "123456",
      });
      expect(correct.status).toBe(400);
      expect(correct.headers.get("location")).toBeNull();
      expect(await correct.text()).toContain(TOO_MANY);
    });

    it("caps SMS resends per login session", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env, getSentSms } = server;
      await env.data.authenticationMethods.create("tenantId", {
        user_id: USER_ID,
        type: "phone",
        phone_number: "+46701234567",
        confirmed: true,
      });
      const session = await createMfaSession(env);

      for (let i = 0; i < MFA_MAX_SMS_SENDS; i++) {
        const res = await post(server, "/mfa/phone-challenge", session.id, {
          action: "resend",
        });
        expect(await res.text()).not.toContain("exceeded the maximum number");
      }
      expect(getSentSms()).toHaveLength(MFA_MAX_SMS_SENDS);

      const over = await post(server, "/mfa/phone-challenge", session.id, {
        action: "resend",
      });
      expect(await over.text()).toContain(
        "exceeded the maximum number of phone messages",
      );
      expect(getSentSms()).toHaveLength(MFA_MAX_SMS_SENDS);
    });

    it("does not send an SMS when the per-user rate limit denies it", async () => {
      const consumed: string[] = [];
      const server = await getTestServer({
        testTenantLanguage: "en",
        rateLimit: {
          consume: async (_scope, key) => {
            consumed.push(key);
            return { allowed: false };
          },
        },
      });
      const { env, getSentSms } = server;
      await env.data.authenticationMethods.create("tenantId", {
        user_id: USER_ID,
        type: "phone",
        phone_number: "+46701234567",
        confirmed: true,
      });
      const session = await createMfaSession(env);

      const res = await post(server, "/mfa/phone-challenge", session.id, {
        action: "resend",
      });
      expect(await res.text()).toContain(
        "exceeded the maximum number of phone messages",
      );
      expect(consumed).toEqual([`mfa-sms:tenantId:${USER_ID}`]);
      expect(getSentSms()).toHaveLength(0);
    });
  });

  describe("TOTP login enrollment", () => {
    it("fails the login session on the Nth bad code and keeps the enrollment unconfirmed", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      const enrollment = await env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "totp",
          totp_secret: TOTP_SECRET,
          confirmed: false,
        },
      );
      const session = await createMfaSession(env, {
        authenticationMethodId: enrollment.id,
        totpSecret: TOTP_SECRET,
      });

      for (let i = 1; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
        const res = await post(server, "/mfa/totp-enrollment", session.id, {
          code: await wrongTotp(),
        });
        expect(res.status).toBe(400);
      }
      const last = await post(server, "/mfa/totp-enrollment", session.id, {
        code: await wrongTotp(),
      });
      expect(await last.text()).toContain(TOO_MANY);
      await expectLockedOut(env, session.id);

      const correct = await post(server, "/mfa/totp-enrollment", session.id, {
        code: await validTotp(),
      });
      expect(correct.status).toBe(400);
      const stored = await env.data.authenticationMethods.get(
        "tenantId",
        enrollment.id,
      );
      expect(stored?.confirmed).toBe(false);
    });
  });

  describe("account security enrollment", () => {
    async function seedAccountSession(env: TestEnv) {
      const loginSession = await env.data.loginSessions.create("tenantId", {
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        csrf_token: "csrf",
        authParams: { client_id: "clientId" },
      });
      await env.data.sessions.create("tenantId", {
        id: "account-mfa-limit-session",
        user_id: USER_ID,
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
      return loginSession.id;
    }

    const accountHeaders = {
      ...formHeaders,
      cookie: "tenantId-auth-token=account-mfa-limit-session",
    };
    const ACCOUNT_TOO_MANY = "Too many failed attempts";

    it("locks TOTP enrollment after N bad codes and rejects a correct code", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      const state = await seedAccountSession(env);

      const getRes = await server.u2App.request(
        `/account/security/totp-enrollment?state=${encodeURIComponent(state)}`,
        { method: "GET", headers: accountHeaders },
        env,
      );
      expect(getRes.status).toBe(200);
      const session = await env.data.loginSessions.get("tenantId", state);
      const secret: string = JSON.parse(session!.state_data!).totpSecret;

      for (let i = 1; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
        const res = await post(
          server,
          "/account/security/totp-enrollment",
          state,
          { code: await wrongTotp(secret) },
          accountHeaders,
        );
        expect(await res.text()).toContain("Invalid code");
      }
      const last = await post(
        server,
        "/account/security/totp-enrollment",
        state,
        { code: await wrongTotp(secret) },
        accountHeaders,
      );
      expect(await last.text()).toContain(ACCOUNT_TOO_MANY);
      await expectLockedOut(env, state);

      const correct = await post(
        server,
        "/account/security/totp-enrollment",
        state,
        { code: await validTotp(secret) },
        accountHeaders,
      );
      expect(correct.headers.get("location")).toBeNull();
      expect(await correct.text()).toContain(ACCOUNT_TOO_MANY);
      const methods = await env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods.filter((m) => m.type === "totp")).toHaveLength(0);

      // Re-opening the enrollment screen on the locked session shows the error
      const reopen = await server.u2App.request(
        `/account/security/totp-enrollment?state=${encodeURIComponent(state)}`,
        { method: "GET", headers: accountHeaders },
        env,
      );
      expect(reopen.status).toBe(200);
      expect(await reopen.text()).toContain(ACCOUNT_TOO_MANY);
    });

    it("keys the account SMS rate limit by the signed-in user, not the phone number", async () => {
      const consumed: string[] = [];
      const server = await getTestServer({
        testTenantLanguage: "en",
        rateLimit: {
          consume: async (_scope, key) => {
            consumed.push(key);
            return { allowed: !key.startsWith("mfa-sms:") };
          },
        },
      });
      const { env, getSentSms } = server;
      const state = await seedAccountSession(env);

      const res = await post(
        server,
        "/account/security/phone-enrollment",
        state,
        { action: "submit_phone", phone_number: "+46701234567" },
        accountHeaders,
      );
      expect(await res.text()).toContain("Too many verification codes");
      expect(consumed).toContain(`mfa-sms:tenantId:${USER_ID}`);
      expect(getSentSms()).toHaveLength(0);
    });

    it("locks phone enrollment after N bad codes and rejects a correct code", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const { env } = server;
      const state = await seedAccountSession(env);

      await post(
        server,
        "/account/security/phone-enrollment",
        state,
        { action: "submit_phone", phone_number: "+46701234567" },
        accountHeaders,
      );
      const code = await env.data.codes.get(
        "tenantId",
        `mfa:${state}`,
        "mfa_otp",
      );
      expect(code?.otp).toBeTruthy();
      const wrong = code!.otp === "000000" ? "111111" : "000000";

      for (let i = 1; i < MFA_MAX_FAILED_ATTEMPTS; i++) {
        const res = await post(
          server,
          "/account/security/phone-enrollment",
          state,
          { action: "verify_code", code: wrong },
          accountHeaders,
        );
        expect(await res.text()).toContain("Invalid code");
      }
      const last = await post(
        server,
        "/account/security/phone-enrollment",
        state,
        { action: "verify_code", code: wrong },
        accountHeaders,
      );
      expect(await last.text()).toContain(ACCOUNT_TOO_MANY);
      await expectLockedOut(env, state);

      const correct = await post(
        server,
        "/account/security/phone-enrollment",
        state,
        { action: "verify_code", code: code!.otp! },
        accountHeaders,
      );
      expect(correct.headers.get("location")).toBeNull();
      expect(await correct.text()).toContain(ACCOUNT_TOO_MANY);
      const methods = await env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods.find((m) => m.type === "phone")?.confirmed).toBe(false);
    });
  });
});
