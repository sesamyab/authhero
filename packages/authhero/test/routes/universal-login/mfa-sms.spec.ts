import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
  Strategy,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";

const USER_ID = "email|userId";
const PHONE_INPUT = "+46 70 123 45 67";
const PHONE_E164 = "+46701234567";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

/**
 * Enable the SMS factor (optionally with OTP as well) and the "always" policy
 * directly on the tenant.
 */
async function enableSmsMfa(
  server: TestServer,
  factors: { sms?: boolean; otp?: boolean } = { sms: true },
  extra: Record<string, unknown> = {},
) {
  await server.env.data.tenants.update("tenantId", {
    mfa: {
      policy: "always",
      factors: { sms: false, otp: false, ...factors },
      ...extra,
    },
  } as any);
}

async function createMfaLoginSession(server: TestServer, state?: string) {
  const sessionId = `session-${Math.random().toString(36).slice(2)}`;
  const loginSession = await server.env.data.loginSessions.create("tenantId", {
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
    state: state ?? LoginSessionState.AWAITING_MFA,
  });
  // createFrontChannelAuthResponse needs a session once MFA completes
  await server.env.data.sessions.create("tenantId", {
    id: sessionId,
    user_id: USER_ID,
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
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
  await server.env.data.loginSessions.update("tenantId", loginSession.id, {
    session_id: sessionId,
  });
  return (await server.env.data.loginSessions.get(
    "tenantId",
    loginSession.id,
  ))!;
}

function form(data: Record<string, string>) {
  return {
    "tenant-id": "tenantId",
    "content-type": "application/x-www-form-urlencoded",
    body: new URLSearchParams(data).toString(),
  };
}

function post(
  server: TestServer,
  path: string,
  state: string,
  data: Record<string, string>,
  env: any = server.env,
  extraHeaders: Record<string, string> = {},
) {
  const f = form(data);
  return server.u2App.request(
    `${path}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": f["tenant-id"],
        "content-type": f["content-type"],
        ...extraHeaders,
      },
      body: f.body,
    },
    env,
  );
}

function get(server: TestServer, path: string, state: string) {
  return server.u2App.request(
    `${path}?state=${encodeURIComponent(state)}`,
    { method: "GET", headers: { "tenant-id": "tenantId" } },
    server.env,
  );
}

/** Run phone enrollment up to the point where the SMS has been sent. */
async function enrollPhone(server: TestServer, state: string) {
  const res = await post(server, "/mfa/phone-enrollment", state, {
    phone_number: PHONE_INPUT,
  });
  expect(res.status).toBe(302);
  return res;
}

function lastCode(server: TestServer): string {
  const sent = server.getSentSms();
  const last = sent[sent.length - 1];
  expect(last).toBeTruthy();
  return (last!.data as { code: string }).code;
}

/**
 * Swap data.smsService for the duration of fn. The u2 routes read the adapter
 * from the shared data object, so a copied env would not take effect.
 */
async function withSmsService<T>(
  server: TestServer,
  service: { send: (params: any) => Promise<void> } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const data = server.env.data as { smsService?: unknown };
  const original = data.smsService;
  data.smsService = service;
  try {
    return await fn();
  } finally {
    data.smsService = original;
  }
}

const failingSms = {
  send: async () => {
    throw new Error("provider down");
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("MFA SMS", () => {
  describe("/u2/mfa/phone-enrollment", () => {
    it("renders the phone entry screen", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);

      const res = await get(server, "/mfa/phone-enrollment", ls.id);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("authhero-widget");
    });

    it("rejects a GET when the user already has a confirmed MFA method", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      await server.env.data.authenticationMethods.create("tenantId", {
        user_id: USER_ID,
        type: "phone",
        phone_number: PHONE_E164,
        confirmed: true,
      });
      const ls = await createMfaLoginSession(server);

      const res = await get(server, "/mfa/phone-enrollment", ls.id);
      expect(res.status).toBe(403);
    });

    it("normalises the number to E.164, creates an unconfirmed enrollment and sends the OTP", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);

      const res = await enrollPhone(server, ls.id);
      expect(res.headers.get("location")).toContain("/mfa/phone-challenge");

      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods).toHaveLength(1);
      expect(methods[0]).toMatchObject({
        type: "phone",
        phone_number: PHONE_E164,
        confirmed: false,
      });

      const sent = server.getSentSms();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(PHONE_E164);
      expect(sent[0]!.template).toBe("mfa-code");
      expect(lastCode(server)).toMatch(/^\d{6}$/);
      expect(sent[0]!.text).toContain(lastCode(server));

      // The session is linked to the enrollment
      const session = await server.env.data.loginSessions.get(
        "tenantId",
        ls.id,
      );
      expect(JSON.parse(session!.state_data!).authenticationMethodId).toBe(
        methods[0]!.id,
      );
    });

    it("parses national numbers with the default country (US) when none is detected", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);

      // No countryCode set → defaults to US
      const res = await post(server, "/mfa/phone-enrollment", ls.id, {
        phone_number: "(415) 555-2671",
      });
      expect(res.status).toBe(302);
      expect(server.getSentSms()[0]!.to).toBe("+14155552671");
    });

    it("re-renders with an error on an empty number", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/phone-enrollment", ls.id, {
        phone_number: "  ",
      });
      expect(res.status).toBe(400);
      expect(server.getSentSms()).toHaveLength(0);
      expect(
        await server.env.data.authenticationMethods.list("tenantId", USER_ID),
      ).toHaveLength(0);
    });

    it("re-renders with an error on an invalid number and sends nothing", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/phone-enrollment", ls.id, {
        phone_number: "12345",
      });
      expect(res.status).toBe(400);
      expect(server.getSentSms()).toHaveLength(0);
      expect(
        await server.env.data.authenticationMethods.list("tenantId", USER_ID),
      ).toHaveLength(0);
    });

    it("refuses to enroll when a confirmed factor already exists", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      await server.env.data.authenticationMethods.create("tenantId", {
        user_id: USER_ID,
        type: "phone",
        phone_number: PHONE_E164,
        confirmed: true,
      });
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/phone-enrollment", ls.id, {
        phone_number: PHONE_INPUT,
      });
      expect(res.status).toBe(403);
      expect(server.getSentSms()).toHaveLength(0);
    });

    it("rolls back the enrollment when the SMS provider fails", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await withSmsService(server, failingSms, () =>
        post(server, "/mfa/phone-enrollment", ls.id, {
          phone_number: PHONE_INPUT,
        }),
      );
      expect(res.status).toBe(400);
      expect(
        await server.env.data.authenticationMethods.list("tenantId", USER_ID),
      ).toHaveLength(0);
      const session = await server.env.data.loginSessions.get(
        "tenantId",
        ls.id,
      );
      const stateData = session!.state_data
        ? JSON.parse(session!.state_data)
        : {};
      expect(stateData.authenticationMethodId).toBeUndefined();
      errSpy.mockRestore();
    });

    // Needs human review: today a missing data.smsService surfaces as a
    // generic "sms-authenticator-error" screen (the 500 "SMS service not
    // configured" is swallowed by the enrollment catch block).
    it("documents behaviour when data.smsService is missing: enrollment rolled back, error screen", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await withSmsService(server, undefined, () =>
        post(server, "/mfa/phone-enrollment", ls.id, {
          phone_number: PHONE_INPUT,
        }),
      );
      expect(res.status).toBe(400);
      expect(
        await server.env.data.authenticationMethods.list("tenantId", USER_ID),
      ).toHaveLength(0);
      errSpy.mockRestore();
    });
  });

  describe("/u2/mfa/phone-challenge", () => {
    async function enrolled(server: TestServer) {
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      await enrollPhone(server, ls.id);
      return ls;
    }

    it("renders the challenge screen", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const res = await get(server, "/mfa/phone-challenge", ls.id);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("authhero-widget");
    });

    it("confirms the enrollment and continues the flow on a correct code", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);

      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        code: lastCode(server),
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        "https://example.com/callback",
      );

      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(true);

      const session = await server.env.data.loginSessions.get(
        "tenantId",
        ls.id,
      );
      expect(JSON.parse(session!.state_data!).mfa_verified).toBe(true);
    });

    it("rejects a wrong code and leaves the enrollment unconfirmed", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const correct = lastCode(server);
      const wrong = correct === "000000" ? "111111" : "000000";

      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        code: wrong,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("authhero-widget");

      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(false);

      // The correct code still works afterwards (no attempt limit today, see #1665)
      const ok = await post(server, "/mfa/phone-challenge", ls.id, {
        code: correct,
      });
      expect(ok.status).toBe(302);
    });

    it("rejects an empty code", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        code: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a code once the login session is no longer AWAITING_MFA", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      await server.env.data.loginSessions.update("tenantId", ls.id, {
        state: LoginSessionState.AUTHENTICATED,
      });
      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        code: lastCode(server),
      });
      expect(res.status).toBe(400);
    });

    it("resend sends a new code to the enrolled number and invalidates the old one", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const first = lastCode(server);

      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        action: "resend",
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("We sent a new code to your phone");
      expect(body).not.toContain("There was a problem sending the SMS");

      const sent = server.getSentSms();
      expect(sent).toHaveLength(2);
      expect(sent[1]!.to).toBe(PHONE_E164);
      const second = lastCode(server);

      if (second !== first) {
        const stale = await post(server, "/mfa/phone-challenge", ls.id, {
          code: first,
        });
        expect(stale.status).toBe(400);
      }
      const ok = await post(server, "/mfa/phone-challenge", ls.id, {
        code: second,
      });
      expect(ok.status).toBe(302);
    });

    it("resend shows an error message when the SMS provider fails", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const res = await withSmsService(server, failingSms, () =>
        post(server, "/mfa/phone-challenge", ls.id, { action: "resend" }),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("There was a problem sending the SMS");
      expect(body).not.toContain("We sent a new code to your phone");
      expect(server.getSentSms()).toHaveLength(1);
    });

    it("rejects the code after the 10 minute expiry", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date());
      await enrollPhone(server, ls.id);
      const code = lastCode(server);

      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      const res = await post(server, "/mfa/phone-challenge", ls.id, { code });
      expect(res.status).toBe(400);
      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(false);
    });

    it("accepts the code just before the expiry", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date());
      await enrollPhone(server, ls.id);
      const code = lastCode(server);

      vi.advanceTimersByTime(9 * 60 * 1000);
      const res = await post(server, "/mfa/phone-challenge", ls.id, { code });
      expect(res.status).toBe(302);
    });

    it("is single use: the code is consumed on success", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      const code = lastCode(server);

      const consume = vi.spyOn(server.env.data.codes, "consume");
      const first = await post(server, "/mfa/phone-challenge", ls.id, { code });
      expect(first.status).toBe(302);
      expect(consume).toHaveBeenCalledWith("tenantId", `mfa:${ls.id}`);

      // Put the session back in AWAITING_MFA so only the consumed code blocks a replay
      await server.env.data.loginSessions.update("tenantId", ls.id, {
        state: LoginSessionState.AWAITING_MFA,
      });
      const replay = await post(server, "/mfa/phone-challenge", ls.id, {
        code,
      });
      expect(replay.status).toBe(400);
    });

    it("loses the race when codes.consume returns false", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      const ls = await enrolled(server);
      vi.spyOn(server.env.data.codes, "consume").mockResolvedValue(false);

      const res = await post(server, "/mfa/phone-challenge", ls.id, {
        code: lastCode(server),
      });
      expect(res.status).toBe(400);
      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(false);
    });

    it("sends the OTP at login for an enrolled user via login-options", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const method = await server.env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "phone",
          phone_number: PHONE_E164,
          confirmed: true,
        },
      );
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/login-options", ls.id, {
        [`factor_${method.id}`]: "",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/mfa/phone-challenge");
      expect(server.getSentSms()).toHaveLength(1);
      expect(server.getSentSms()[0]!.to).toBe(PHONE_E164);

      const ok = await post(server, "/mfa/phone-challenge", ls.id, {
        code: lastCode(server),
      });
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toContain(
        "https://example.com/callback",
      );
    });
  });

  describe("sendMfaOtp provider choice", () => {
    async function enrollAndGetSent(server: TestServer) {
      const ls = await createMfaLoginSession(server);
      await enrollPhone(server, ls.id);
      return server.getSentSms()[0]!;
    }

    it("uses the SMS connection options when a connection exists", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(
        server,
        { sms: true },
        {
          twilio: { sid: "tenant_sid", auth_token: "tenant_token" },
        },
      );
      await server.env.data.connections.create("tenantId", {
        id: "sms-conn",
        name: "sms",
        strategy: Strategy.SMS,
        options: {
          provider: "twilio",
          from: "+1234567890",
          twilio_sid: "conn_sid",
          twilio_token: "conn_token",
        },
      } as any);

      const sent = await enrollAndGetSent(server);
      expect(sent.options).toMatchObject({
        twilio_sid: "conn_sid",
        twilio_token: "conn_token",
      });
    });

    it("falls back to tenant.mfa.twilio without an SMS connection", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(
        server,
        { sms: true },
        {
          twilio: { sid: "tenant_sid", auth_token: "tenant_token", from: "+1" },
        },
      );

      const sent = await enrollAndGetSent(server);
      expect(sent.options).toEqual({
        sid: "tenant_sid",
        auth_token: "tenant_token",
        from: "+1",
      });
    });

    it("passes empty options when neither is configured", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const sent = await enrollAndGetSent(server);
      expect(sent.options).toEqual({});
    });

    it("provides a service-token factory and tenant data to the sms service", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const sent = await enrollAndGetSent(server);
      expect(typeof sent.createServiceToken).toBe("function");
      expect(sent.data).toMatchObject({ tenantId: "tenantId" });
    });
  });

  describe("missing data.smsService", () => {
    // Needs human review: sendMfaOtp throws a 500 "SMS service not
    // configured" *after* it has stored the OTP row. Via login-options (user
    // already enrolled) nothing catches it, so the user gets a raw 500.
    it("documents: login-options for an enrolled user returns a 500", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const method = await server.env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "phone",
          phone_number: PHONE_E164,
          confirmed: true,
        },
      );
      const ls = await createMfaLoginSession(server);

      const res = await withSmsService(server, undefined, () =>
        post(server, "/mfa/login-options", ls.id, {
          [`factor_${method.id}`]: "",
        }),
      );
      expect(res.status).toBe(500);
    });

    it("documents: resend shows an error message instead of failing", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const ls = await createMfaLoginSession(server);
      await enrollPhone(server, ls.id);

      const res = await withSmsService(server, undefined, () =>
        post(server, "/mfa/phone-challenge", ls.id, { action: "resend" }),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("There was a problem sending the SMS");
      expect(body).not.toContain("We sent a new code to your phone");
      expect(server.getSentSms()).toHaveLength(1);
    });
  });

  describe("/u2/mfa/login-options", () => {
    it("offers both enroll options when OTP and SMS are enabled", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server, { sms: true, otp: true });
      const ls = await createMfaLoginSession(server);

      const res = await get(server, "/mfa/login-options", ls.id);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("factor_enroll-phone");
      expect(html).toContain("factor_enroll-totp");
    });

    it("selecting SMS redirects to phone enrollment", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server, { sms: true, otp: true });
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/login-options", ls.id, {
        "factor_enroll-phone": "",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/mfa/phone-enrollment");
    });

    it("rejects SMS enrollment when the SMS factor is disabled", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server, { sms: false, otp: true });
      const ls = await createMfaLoginSession(server);

      const res = await post(server, "/mfa/login-options", ls.id, {
        "factor_enroll-phone": "",
      });
      expect(res.status).toBe(403);
    });

    it("only offers the confirmed SMS factor (masked) to an enrolled user", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server, { sms: true, otp: true });
      const method = await server.env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "phone",
          phone_number: PHONE_E164,
          confirmed: true,
        },
      );
      const ls = await createMfaLoginSession(server);

      const html = await (
        await get(server, "/mfa/login-options", ls.id)
      ).text();
      expect(html).toContain(`factor_${method.id}`);
      expect(html).toContain("****4567");
      expect(html).not.toContain("factor_enroll-");
      expect(html).not.toContain(PHONE_E164);
    });

    it("rejects choosing a pending (unconfirmed) enrollment", async () => {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const pending = await server.env.data.authenticationMethods.create(
        "tenantId",
        {
          user_id: USER_ID,
          type: "phone",
          phone_number: PHONE_E164,
          confirmed: false,
        },
      );
      const ls = await createMfaLoginSession(server);
      const res = await post(server, "/mfa/login-options", ls.id, {
        [`factor_${pending.id}`]: "",
      });
      expect(res.status).toBe(403);
      expect(server.getSentSms()).toHaveLength(0);
    });
  });

  describe("account security phone enrollment", () => {
    const path = "/account/security/phone-enrollment";
    const cookie = "tenantId-auth-token=account-session";

    async function setup() {
      const server = await getTestServer({ testTenantLanguage: "en" });
      await enableSmsMfa(server);
      const loginSession = await server.env.data.loginSessions.create(
        "tenantId",
        {
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          csrf_token: "csrf",
          authParams: {
            client_id: "clientId",
            redirect_uri: "https://example.com",
          },
        },
      );
      await server.env.data.sessions.create("tenantId", {
        id: "account-session",
        user_id: USER_ID,
        clients: ["clientId"],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
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
      return { server, state: loginSession.id };
    }

    const postAccount = (
      server: TestServer,
      state: string,
      data: Record<string, string>,
      withCookie = true,
    ) =>
      post(server, path, state, data, server.env, withCookie ? { cookie } : {});

    it("redirects to login without a session cookie", async () => {
      const { server, state } = await setup();
      const res = await postAccount(
        server,
        state,
        { action: "submit_phone", phone_number: PHONE_INPUT },
        false,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("state=");
      expect(server.getSentSms()).toHaveLength(0);
    });

    it("sends the OTP, then confirms the enrollment with the code", async () => {
      const { server, state } = await setup();

      const step1 = await postAccount(server, state, {
        action: "submit_phone",
        phone_number: PHONE_INPUT,
      });
      expect(step1.status).toBe(200);
      // Masked number is shown, never the full one
      const html = await step1.text();
      expect(html).not.toContain(PHONE_E164);

      expect(server.getSentSms()).toHaveLength(1);
      expect(server.getSentSms()[0]!.to).toBe(PHONE_E164);
      let methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods).toHaveLength(1);
      expect(methods[0]).toMatchObject({
        phone_number: PHONE_E164,
        confirmed: false,
      });

      const step2 = await postAccount(server, state, {
        action: "verify_code",
        code: lastCode(server),
      });
      expect(step2.status).toBe(302);
      expect(step2.headers.get("location")).toContain("/account/security");

      methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(true);

      // state_data is cleaned up
      const session = await server.env.data.loginSessions.get(
        "tenantId",
        state,
      );
      const stateData = session!.state_data
        ? JSON.parse(session!.state_data)
        : {};
      expect(stateData.authenticationMethodId).toBeUndefined();
      expect(stateData.phoneNumber).toBeUndefined();
    });

    it("rejects an invalid number", async () => {
      const { server, state } = await setup();
      const res = await postAccount(server, state, {
        action: "submit_phone",
        phone_number: "12345",
      });
      expect(res.status).toBe(400);
      expect(server.getSentSms()).toHaveLength(0);
    });

    it("rejects an empty number", async () => {
      const { server, state } = await setup();
      const res = await postAccount(server, state, {
        action: "submit_phone",
        phone_number: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a wrong code and keeps the enrollment unconfirmed", async () => {
      const { server, state } = await setup();
      await postAccount(server, state, {
        action: "submit_phone",
        phone_number: PHONE_INPUT,
      });
      const correct = lastCode(server);
      const wrong = correct === "000000" ? "111111" : "000000";

      const res = await postAccount(server, state, {
        action: "verify_code",
        code: wrong,
      });
      expect(res.status).toBe(400);
      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods[0]!.confirmed).toBe(false);
    });

    it("rolls back the enrollment when sending fails", async () => {
      const { server, state } = await setup();
      const res = await withSmsService(server, failingSms, () =>
        post(
          server,
          path,
          state,
          { action: "submit_phone", phone_number: PHONE_INPUT },
          server.env,
          { cookie },
        ),
      );
      expect(res.status).toBe(400);
      expect(
        await server.env.data.authenticationMethods.list("tenantId", USER_ID),
      ).toHaveLength(0);
    });

    it("does not allow the same code to confirm twice (single use)", async () => {
      const { server, state } = await setup();
      await postAccount(server, state, {
        action: "submit_phone",
        phone_number: PHONE_INPUT,
      });
      const code = lastCode(server);
      const before = await server.env.data.loginSessions.get("tenantId", state);
      const ok = await postAccount(server, state, {
        action: "verify_code",
        code,
      });
      expect(ok.status).toBe(302);

      // A successful enrollment clears the pending enrollment from state_data,
      // so restore it: only the consumed code should now block the replay.
      await server.env.data.loginSessions.update("tenantId", state, {
        state_data: before!.state_data,
      });
      const replay = await postAccount(server, state, {
        action: "verify_code",
        code,
      });
      expect(replay.status).toBe(400);
      const methods = await server.env.data.authenticationMethods.list(
        "tenantId",
        USER_ID,
      );
      expect(methods).toHaveLength(1);
    });
  });
});
