import { describe, expect, it } from "vitest";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { u2Screen } from "../../helpers/u2-screen";
import en from "../../../locales/en.json";
import { LOGIN_OTP_MAX_SENDS } from "../../../src/routes/universal-login/screens/login-otp";
import { codeRecipientState } from "../../../src/helpers/code-recipient";

const emailOtp = en["email-otp-challenge"]["email-otp-challenge"];
const smsOtp = en["sms-otp-challenge"]["sms-otp-challenge"];
const magicLink = en["magic-link-sent"]["magic-link-sent"];

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

async function createSession(
  env: TestServer["env"],
  username: string | undefined,
  {
    issueCode = true,
    codeRecipient = username,
  }: { issueCode?: boolean; codeRecipient?: string } = {},
) {
  const session = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      ...(username ? { username } : {}),
    },
  });
  if (issueCode) {
    // The code the identifier step sent before the user asked for a new one
    await env.data.codes.create("tenantId", {
      code_id: "111111",
      code_type: "otp",
      login_id: session.id,
      expires_at: new Date(Date.now() + 600 * 1000).toISOString(),
      ...(codeRecipient ? { state: codeRecipientState(codeRecipient) } : {}),
    });
  }
  return session.id;
}

/** POST to the JSON screen API the way the widget does. */
async function postScreen(
  server: TestServer,
  screenId: string,
  state: string,
  data: Record<string, unknown>,
) {
  return server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/json",
      },
      body: JSON.stringify({ data }),
    },
    server.env,
  );
}

describe("login OTP resend", () => {
  it("sends a new email code from email-otp-challenge", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screen.name).toBe("email-otp-challenge");
    expect(body.screen.messages).toEqual([
      { text: emailOtp.resendSuccess, type: "success" },
    ]);
    // Resend re-renders the same screen, so no client-side navigation
    expect(body.navigateUrl).toBeUndefined();

    const emails = server.getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("foo@example.com");
    expect(emails[0].data.code).toMatch(/^\d{6}$/);
    expect(emails[0].data.code).not.toBe("111111");
  });

  it("ignores a typed code when resending", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
      code: "123",
    });

    expect(response.status).toBe(200);
    expect(server.getSentEmails()).toHaveLength(1);
  });

  it("sends nothing when no code was issued for the session (enumeration-safe stub)", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "unknown@example.com", {
      issueCode: false,
    });

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    // Looks the same as a real resend, but nothing is delivered
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screen.messages).toEqual([
      { text: emailOtp.resendSuccess, type: "success" },
    ]);
    expect(server.getSentEmails()).toHaveLength(0);
  });

  it("sends nothing when the only code was issued to another address", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "unknown@example.com", {
      codeRecipient: "foo@example.com",
    });

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    expect(response.status).toBe(200);
    expect((await response.json()).screen.messages).toEqual([
      { text: emailOtp.resendSuccess, type: "success" },
    ]);
    expect(server.getSentEmails()).toHaveLength(0);
  });

  it("binds the resent code to the recipient", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    const sentCode = server.getSentEmails()[0].data.code;
    const stored = await server.env.data.codes.get("tenantId", sentCode, "otp");
    expect(JSON.parse(stored!.state!).recipient).toBe("foo@example.com");
  });

  it("reports an expired session when the session has no username", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, undefined);

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body.screen.messages)).toContain(
      emailOtp.sessionExpired,
    );
    expect(server.getSentEmails()).toHaveLength(0);
  });

  it("sends a new SMS code from sms-otp-challenge", async () => {
    const server = await getTestServer({ mockEmail: true });
    await server.env.data.connections.create("tenantId", {
      id: "sms",
      name: "sms",
      strategy: Strategy.SMS,
      options: {
        provider: "twilio",
        from: "+1234567890",
        twilio_sid: "mock_account_sid",
        twilio_token: "mock_auth_token",
      },
    });
    const state = await createSession(server.env, "+46701234567");

    const response = await postScreen(server, "sms-otp-challenge", state, {
      action: "resend",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screen.name).toBe("sms-otp-challenge");
    expect(body.screen.messages).toEqual([
      { text: smsOtp.resendSuccess, type: "success" },
    ]);
    const sms = server.getSentSms();
    expect(sms).toHaveLength(1);
    expect(sms[0].to).toBe("+46701234567");
  });
});

describe("login OTP send cap", () => {
  it(`stops sending after ${LOGIN_OTP_MAX_SENDS} resends but keeps the neutral response`, async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    for (let i = 0; i < LOGIN_OTP_MAX_SENDS + 2; i++) {
      const response = await postScreen(server, "email-otp-challenge", state, {
        action: "resend",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.screen.messages).toEqual([
        { text: emailOtp.resendSuccess, type: "success" },
      ]);
    }

    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);
  });

  it("counts identifier submits and resends against the same cap", async () => {
    const server = await getTestServer({ mockEmail: true });
    await server.env.data.connections.update("tenantId", "email", {
      options: { authentication_method: "code" },
    });
    const state = await createSession(server.env, undefined, {
      issueCode: false,
    });

    for (let i = 0; i < LOGIN_OTP_MAX_SENDS; i++) {
      const response = await postScreen(server, "identifier", state, {
        username: "foo@example.com",
      });
      expect(response.status).toBe(200);
      expect((await response.json()).screenId).toBe("email-otp-challenge");
    }
    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);

    // Both paths still answer as usual past the cap
    const again = await postScreen(server, "identifier", state, {
      username: "foo@example.com",
    });
    expect((await again.json()).screenId).toBe("email-otp-challenge");
    const resend = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });
    expect(resend.status).toBe(200);
    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);
  });

  it("applies the cap to the passwordless identifier screen", async () => {
    const server = await getTestServer({ mockEmail: true });
    await server.env.data.connections.update("tenantId", "email", {
      options: { authentication_method: "code" },
    });
    const state = await createSession(server.env, undefined, {
      issueCode: false,
    });

    for (let i = 0; i < LOGIN_OTP_MAX_SENDS + 1; i++) {
      const response = await postScreen(
        server,
        "login-passwordless-identifier",
        state,
        { username: "foo@example.com" },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).screenId).toBe("email-otp-challenge");
    }
    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);
  });

  it("consumes the per-recipient rate limit and skips delivery when it denies", async () => {
    const consumed: Array<{ scope: string; key: string }> = [];
    const server = await getTestServer({
      mockEmail: true,
      rateLimit: {
        consume: async (scope: string, key: string) => {
          consumed.push({ scope, key });
          return { allowed: false, retryAfterSeconds: 60 };
        },
      },
    });
    const state = await createSession(server.env, "Foo@Example.com");

    const response = await postScreen(server, "email-otp-challenge", state, {
      action: "resend",
    });

    expect(response.status).toBe(200);
    expect((await response.json()).screen.messages).toEqual([
      { text: emailOtp.resendSuccess, type: "success" },
    ]);
    expect(server.getSentEmails()).toHaveLength(0);
    expect(consumed).toContainEqual({
      scope: "brute-force",
      key: "login-otp-send:tenantId:foo@example.com",
    });
  });

  it("does not use up the session allowance when the rate limit rejects", async () => {
    let allow = false;
    const server = await getTestServer({
      mockEmail: true,
      rateLimit: { consume: async () => ({ allowed: allow }) },
    });
    const state = await createSession(server.env, "foo@example.com");

    // Rejected by the recipient limit: nothing sent, nothing counted
    for (let i = 0; i < LOGIN_OTP_MAX_SENDS; i++) {
      await postScreen(server, "email-otp-challenge", state, {
        action: "resend",
      });
    }
    expect(server.getSentEmails()).toHaveLength(0);
    const session = await server.env.data.loginSessions.get("tenantId", state);
    expect(session?.state_data ?? "").not.toContain("login_otp_sent");

    // Once the limit resets the session still has its full allowance
    allow = true;
    for (let i = 0; i < LOGIN_OTP_MAX_SENDS + 1; i++) {
      await postScreen(server, "email-otp-challenge", state, {
        action: "resend",
      });
    }
    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);
  });

  it("does not consume the recipient rate limit once the session is at its cap", async () => {
    let consumed = 0;
    const server = await getTestServer({
      mockEmail: true,
      rateLimit: {
        consume: async () => {
          consumed++;
          return { allowed: true };
        },
      },
    });
    const state = await createSession(server.env, "foo@example.com");

    for (let i = 0; i < LOGIN_OTP_MAX_SENDS + 3; i++) {
      await postScreen(server, "email-otp-challenge", state, {
        action: "resend",
      });
    }
    expect(server.getSentEmails()).toHaveLength(LOGIN_OTP_MAX_SENDS);
    expect(consumed).toBe(LOGIN_OTP_MAX_SENDS);
  });
});

describe("magic-link-sent screen", () => {
  it("is served at /u2/login/magic-link-sent", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    const response = await u2Screen(
      server.u2App,
      server.env,
      "login/magic-link-sent",
    ).$get({ query: { state } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(magicLink.title);
    expect(html).toContain("fo***@example.com");
  });

  it("is served by the JSON screen API", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    const response = await server.u2App.request(
      `/screen/magic-link-sent?state=${encodeURIComponent(state)}`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screen.name).toBe("magic-link-sent");
    expect(body.screen.action).toContain("/u2/screen/magic-link-sent");
    expect(body.screen.description).toContain("fo***@example.com");
  });

  it("resends the magic link", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, "foo@example.com");

    const response = await postScreen(server, "magic-link-sent", state, {
      action: "resend",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screen.name).toBe("magic-link-sent");
    expect(body.screen.messages).toEqual([
      { text: magicLink.resendSuccess, type: "success" },
    ]);
    const emails = server.getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("foo@example.com");
    // A magic link, not a bare code email
    expect(JSON.stringify(emails[0])).toContain("verification_code=");
  });

  it("is navigated to under /u2/login after the identifier step", async () => {
    const server = await getTestServer({ mockEmail: true });
    const state = await createSession(server.env, undefined, {
      issueCode: false,
    });

    const response = await postScreen(server, "identifier", state, {
      username: "new-user@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screenId).toBe("magic-link-sent");
    expect(body.navigateUrl).toBe(
      `/u2/login/magic-link-sent?state=${encodeURIComponent(state)}`,
    );
  });
});
