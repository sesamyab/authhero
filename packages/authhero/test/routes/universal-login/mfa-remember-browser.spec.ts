import { describe, it, expect, vi } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
  CodeExecutor,
  LoginSessionState,
  Tenant,
  decodeBase32,
  encodeHex,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import { generateTOTP } from "../../../src/utils/totp";
import {
  isRememberBrowserAllowed,
  wantsRememberBrowser,
} from "../../../src/authentication-flows/remember-browser";
import {
  getMfaRememberBrowserTokens,
  serializeMfaRememberBrowserCookie,
} from "../../../src/utils/cookies";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;
type TestEnv = TestServer["env"];

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const USER_ID = "email|userId";
const COOKIE_NAME = "tenantId-mfa-remember-browser";
const DAY_MS = 24 * 60 * 60 * 1000;

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

type ApiCall = { method: string; args: unknown[] };

async function setup(
  options: {
    policy?: "always" | "never";
    allowRememberBrowser?: boolean;
    lifetimeInDays?: number;
    /** Post-login action API calls, e.g. multifactor.enable. */
    apiCalls?: ApiCall[];
    enroll?: boolean;
  } = {},
) {
  const codeExecutor: CodeExecutor = {
    async execute() {
      return {
        success: true,
        durationMs: 1,
        apiCalls: options.apiCalls ?? [],
        logs: [],
      };
    },
  };
  const server = await getTestServer({
    testTenantLanguage: "en",
    codeExecutor,
  });
  const { env } = server;

  const tenant = await env.data.tenants.get("tenantId");
  const mfa: NonNullable<Tenant["mfa"]> = {
    ...tenant?.mfa,
    policy: options.policy ?? "always",
    factors: {
      sms: false,
      email: false,
      push_notification: false,
      webauthn_roaming: false,
      webauthn_platform: false,
      recovery_code: false,
      duo: false,
      ...tenant?.mfa?.factors,
      otp: true,
    },
  };
  if (options.allowRememberBrowser !== undefined) {
    mfa.allow_remember_browser = options.allowRememberBrowser;
  }
  if (options.lifetimeInDays !== undefined) {
    mfa.remember_browser_lifetime_in_days = options.lifetimeInDays;
  }
  await env.data.tenants.update("tenantId", { mfa });

  if (options.enroll !== false) {
    await env.data.authenticationMethods.create("tenantId", {
      user_id: USER_ID,
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });
  }

  if (options.apiCalls) {
    const action = await env.data.actions.create("tenantId", {
      name: "require-mfa",
      code: "exports.onExecutePostLogin = async () => {};",
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "post-user-login",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });
  }

  return server;
}

/**
 * A login whose first factor is done and that waits for MFA, as the
 * challenge screen sees it. `stateData` lets a test add an action's request.
 */
async function seedLoginAwaitingMfa(
  env: TestEnv,
  stateData: Record<string, unknown> = {},
) {
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
    state_data: JSON.stringify(stateData),
  });
  return loginSession;
}

async function getTotpChallenge(server: TestServer, state: string) {
  const response = await server.u2App.request(
    `/mfa/totp-challenge?state=${encodeURIComponent(state)}`,
    { headers: { "tenant-id": "tenantId" } },
    server.env,
  );
  expect(response.status).toBe(200);
  return response.text();
}

async function submitTotp(
  server: TestServer,
  state: string,
  fields: Record<string, string> = {},
) {
  const code = await generateTOTP(decodeBase32(TOTP_SECRET));
  return server.u2App.request(
    `/mfa/totp-challenge?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code, ...fields }).toString(),
    },
    server.env,
  );
}

/** The remember-browser tokens a response hands to the browser. */
function rememberedTokens(response: Response): string[] {
  const header = response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return getMfaRememberBrowserTokens("tenantId", header);
}

async function hashToken(token: string) {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

const OTHER_USER_ID = "email|otherUser";

async function createOtherUser(env: TestEnv) {
  await env.data.users.create("tenantId", {
    user_id: OTHER_USER_ID,
    email: "other@example.com",
    email_verified: true,
    provider: "email",
    connection: "email",
    is_social: false,
  });
}

/** Store a remember-browser token directly, bypassing the challenge. */
async function storeToken(
  env: TestEnv,
  token: string,
  options: { userId?: string; expiresInMs?: number } = {},
) {
  await env.data.codes.create("tenantId", {
    code_id: await hashToken(token),
    code_type: "mfa_remember_browser",
    user_id: options.userId ?? USER_ID,
    expires_at: new Date(
      Date.now() + (options.expiresInMs ?? 30 * DAY_MS),
    ).toISOString(),
  });
}

/**
 * A later login of the same user in a new browser session that never
 * completed MFA (e.g. after the earlier session ended), via SSO.
 */
async function laterLogin(server: TestServer, rememberToken?: string) {
  const session = await server.env.data.sessions.create("tenantId", {
    id: `later-${crypto.randomUUID()}`,
    user_id: USER_ID,
    login_session_id: "laterLoginSession",
    device,
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    idle_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  const cookies = [`tenantId-auth-token=${session.id}`];
  if (rememberToken) {
    cookies.push(`${COOKIE_NAME}=${rememberToken}`);
  }
  return testClient(server.oauthApp, server.env).authorize.$get(
    {
      query: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        state: "state",
        nonce: "nonce",
        scope: "openid",
        response_type: AuthorizationResponseType.CODE,
      },
    },
    { headers: { cookie: cookies.join("; ") } },
  );
}

function expectChallenged(response: Response) {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/mfa/totp-challenge");
}

function expectSkippedMfa(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(
    "https://example.com/callback",
  );
  expect(location.searchParams.get("code")).toBeTruthy();
}

describe("remember browser for MFA (#1670)", () => {
  it("offers the option, remembers the browser and skips MFA on a later login", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const html = await getTotpChallenge(server, loginSession.id);
    expect(html).toContain("remember_browser");
    expect(html).toContain("Remember this device for 30 days");

    const response = await submitTotp(server, loginSession.id, {
      remember_browser: "true",
    });
    expect(response.status).toBe(302);
    const setCookies = response.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
    expect(setCookies.length).toBeGreaterThan(0);
    for (const cookie of setCookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    }
    const [token] = rememberedTokens(response);
    expect(token).toBeTruthy();

    // Only the token's hash is stored, bound to the user.
    const stored = await server.env.data.codes.get(
      "tenantId",
      await hashToken(token!),
      "mfa_remember_browser",
    );
    expect(stored?.user_id).toBe(USER_ID);
    expect(stored?.login_id).toBe(loginSession.id);

    // Without the cookie a later login is challenged; with it, it isn't.
    expectChallenged(await laterLogin(server));
    expectSkippedMfa(await laterLogin(server, token));
  });

  it("does not emit amr for a login that skipped MFA on a remembered browser", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const token = "remembered-token";
    await storeToken(server.env, token);

    const response = await laterLogin(server, token);
    expectSkippedMfa(response);

    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenResponse = await testClient(
      server.oauthApp,
      server.env,
    ).oauth.token.$post({
      form: {
        grant_type: "authorization_code",
        client_id: "clientId",
        client_secret: "clientSecret",
        code,
        redirect_uri: "https://example.com/callback",
      },
    });
    expect(tokenResponse.status).toBe(200);
    const body = (await tokenResponse.json()) as { id_token: string };
    const claims = JSON.parse(
      Buffer.from(body.id_token.split(".")[1]!, "base64url").toString("utf8"),
    );
    expect(claims.amr).toBeUndefined();
  });

  it("does not remember the browser when the box is not ticked", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const response = await submitTotp(server, loginSession.id, {
      remember_browser: "false",
    });
    expect(response.status).toBe(302);
    expect(rememberedTokens(response)).toEqual([]);
  });

  it("accepts a plain HTML checkbox value", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const response = await submitTotp(server, loginSession.id, {
      remember_browser: "on",
    });
    expect(rememberedTokens(response)).toHaveLength(1);
  });

  it("neither offers nor honours remembering when the tenant doesn't allow it", async () => {
    const server = await setup();
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const html = await getTotpChallenge(server, loginSession.id);
    expect(html).not.toContain("remember_browser");

    // A forged field does nothing.
    const response = await submitTotp(server, loginSession.id, {
      remember_browser: "true",
    });
    expect(response.status).toBe(302);
    expect(rememberedTokens(response)).toEqual([]);

    // A token left from when the tenant allowed it doesn't skip MFA either.
    await storeToken(server.env, "old-token");
    expectChallenged(await laterLogin(server, "old-token"));
  });

  it("uses the tenant's lifetime, also for tokens issued under a longer one", async () => {
    const server = await setup({
      allowRememberBrowser: true,
      lifetimeInDays: 7,
    });
    const loginSession = await seedLoginAwaitingMfa(server.env);

    expect(await getTotpChallenge(server, loginSession.id)).toContain(
      "Remember this device for 7 days",
    );
    const response = await submitTotp(server, loginSession.id, {
      remember_browser: "true",
    });
    expect(
      response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`)),
    ).toContain(`Max-Age=${7 * 24 * 60 * 60}`);

    // Issued 8 days ago with a 30-day expiry, when the lifetime was longer:
    // past the current 7-day lifetime, so it no longer skips MFA.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 8 * DAY_MS);
    try {
      await storeToken(server.env, "issued-under-30-days");
    } finally {
      vi.useRealTimers();
    }
    expectChallenged(await laterLogin(server, "issued-under-30-days"));

    // One issued within the lifetime still works.
    await storeToken(server.env, "fresh");
    expectSkippedMfa(await laterLogin(server, "fresh"));
  });

  it("does not skip MFA for an expired token or another user's token", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await storeToken(server.env, "expired", { expiresInMs: -1000 });
    await createOtherUser(server.env);
    await storeToken(server.env, "someone-else", {
      userId: OTHER_USER_ID,
    });

    expectChallenged(await laterLogin(server, "expired"));
    expectChallenged(await laterLogin(server, "someone-else"));
    expectChallenged(await laterLogin(server, "never-issued"));
  });

  it("never skips enrollment for a user without a confirmed enrollment", async () => {
    const server = await setup({ allowRememberBrowser: true, enroll: false });
    await storeToken(server.env, "token");

    const response = await laterLogin(server, "token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/mfa/totp-enrollment");
  });

  it("keeps other users' tokens and replaces the user's own when remembering again", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await createOtherUser(server.env);
    await storeToken(server.env, "other-user-token", {
      userId: OTHER_USER_ID,
    });
    await storeToken(server.env, "own-old-token");
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    const response = await server.u2App.request(
      `/mfa/totp-challenge?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${COOKIE_NAME}=own-old-token.other-user-token`,
        },
        body: new URLSearchParams({
          code,
          remember_browser: "true",
        }).toString(),
      },
      server.env,
    );

    const tokens = rememberedTokens(response);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toBe("other-user-token");
    expect(tokens).not.toContain("own-old-token");
  });

  it("invalidates remembered browsers through the management API", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await storeToken(server.env, "token");
    expectSkippedMfa(await laterLogin(server, "token"));

    const token = await getAdminToken();
    const headers = {
      "tenant-id": "tenantId",
      authorization: `Bearer ${token}`,
    };
    const response = await server.managementApp.request(
      `/users/${encodeURIComponent(USER_ID)}/multifactor/actions/invalidate-remember-browser`,
      { method: "POST", headers },
      server.env,
    );
    expect(response.status).toBe(204);
    expectChallenged(await laterLogin(server, "token"));

    // A browser remembered after the invalidation works again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storeToken(server.env, "new-token");
    expectSkippedMfa(await laterLogin(server, "new-token"));

    // Invalidating again is fine (replaces the marker).
    const again = await server.managementApp.request(
      `/users/${encodeURIComponent(USER_ID)}/multifactor/actions/invalidate-remember-browser`,
      { method: "POST", headers },
      server.env,
    );
    expect(again.status).toBe(204);
    expectChallenged(await laterLogin(server, "new-token"));

    const missing = await server.managementApp.request(
      `/users/${encodeURIComponent("email|nobody")}/multifactor/actions/invalidate-remember-browser`,
      { method: "POST", headers },
      server.env,
    );
    expect(missing.status).toBe(404);
  });

  it("stores the tenant settings through the management API", async () => {
    const server = await setup();
    const headers = {
      "tenant-id": "tenantId",
      authorization: `Bearer ${await getAdminToken()}`,
      "content-type": "application/json",
    };
    const patch = (mfa: Record<string, unknown>) =>
      server.managementApp.request(
        "/tenants/settings",
        { method: "PATCH", headers, body: JSON.stringify({ mfa }) },
        server.env,
      );

    expect(
      (
        await patch({
          allow_remember_browser: true,
          remember_browser_lifetime_in_days: 14,
        })
      ).status,
    ).toBe(200);
    const tenant = await server.env.data.tenants.get("tenantId");
    expect(tenant?.mfa?.allow_remember_browser).toBe(true);
    expect(tenant?.mfa?.remember_browser_lifetime_in_days).toBe(14);

    expect((await patch({ remember_browser_lifetime_in_days: 0 })).status).toBe(
      400,
    );
    expect(
      (await patch({ remember_browser_lifetime_in_days: 366 })).status,
    ).toBe(400);
  });

  it("lets a remembered browser pass silent auth", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const session = await server.env.data.sessions.create("tenantId", {
      id: "silentSession",
      user_id: USER_ID,
      login_session_id: "oldLoginSession",
      device,
      clients: ["clientId"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      idle_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await storeToken(server.env, "token");

    const silent = (cookie: string) =>
      testClient(server.oauthApp, server.env).authorize.$get(
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
        { headers: { origin: "https://example.com", cookie } },
      );

    const refused = await silent(`tenantId-auth-token=${session.id}`);
    expect(await refused.text()).toContain("interaction_required");

    const allowed = await silent(
      `tenantId-auth-token=${session.id}; ${COOKIE_NAME}=token`,
    );
    expect(allowed.status).toBe(200);
    const body = await allowed.text();
    expect(body).not.toContain("interaction_required");
    expect(body).toContain('"code"');
  });

  describe("MFA required by a post-login action", () => {
    it("offers remembering and skips the action's MFA when the action allows it", async () => {
      const server = await setup({
        policy: "never",
        apiCalls: [
          {
            method: "multifactor.enable",
            args: ["any", { allowRememberBrowser: true }],
          },
        ],
      });
      const loginSession = await seedLoginAwaitingMfa(server.env, {
        mfa_required_by_action: {
          provider: "any",
          allow_remember_browser: true,
        },
      });
      expect(await getTotpChallenge(server, loginSession.id)).toContain(
        "remember_browser",
      );

      await storeToken(server.env, "token");
      const response = await laterLogin(server, "token");
      expectSkippedMfa(response);
    });

    it("challenges a remembered browser when the action doesn't allow remembering", async () => {
      const server = await setup({
        policy: "always",
        allowRememberBrowser: true,
        apiCalls: [
          {
            method: "multifactor.enable",
            args: ["any", { allowRememberBrowser: false }],
          },
        ],
      });
      const loginSession = await seedLoginAwaitingMfa(server.env, {
        mfa_required_by_action: {
          provider: "any",
          allow_remember_browser: false,
        },
      });
      expect(await getTotpChallenge(server, loginSession.id)).not.toContain(
        "remember_browser",
      );

      await storeToken(server.env, "token");
      const response = await laterLogin(server, "token");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toContain(
        "https://example.com/callback",
      );
    });
  });
});

describe("remember browser helpers", () => {
  it("allows remembering only when every source requiring MFA allows it", () => {
    const policy = (
      policy: "always" | "never",
      allow_remember_browser?: boolean,
    ) => ({ mfa: { policy, allow_remember_browser } });
    const action = (allow_remember_browser: boolean) => ({
      provider: "any",
      allow_remember_browser,
    });

    expect(isRememberBrowserAllowed(policy("never"), undefined)).toBe(false);
    expect(isRememberBrowserAllowed(policy("always"), undefined)).toBe(false);
    expect(isRememberBrowserAllowed(policy("always", true), undefined)).toBe(
      true,
    );
    expect(isRememberBrowserAllowed(policy("never"), action(true))).toBe(true);
    expect(isRememberBrowserAllowed(policy("never"), action(false))).toBe(
      false,
    );
    expect(isRememberBrowserAllowed(policy("always"), action(true))).toBe(
      false,
    );
    expect(
      isRememberBrowserAllowed(policy("always", true), action(false)),
    ).toBe(false);
    expect(isRememberBrowserAllowed(policy("always", true), action(true))).toBe(
      true,
    );
  });

  it("reads the checkbox from the widget and from a plain form", () => {
    expect(wantsRememberBrowser("true")).toBe(true);
    expect(wantsRememberBrowser("on")).toBe(true);
    expect(wantsRememberBrowser(["false", "true"])).toBe(true);
    expect(wantsRememberBrowser("false")).toBe(false);
    expect(wantsRememberBrowser(undefined)).toBe(false);
  });

  it("round-trips several tokens through the cookie, from both jars", () => {
    const [plain, partitioned] = serializeMfaRememberBrowserCookie(
      "tenantId",
      ["a", "b"],
      60,
      "auth.example.com",
    );
    expect(partitioned).toContain("Partitioned");
    const header = [plain, partitioned]
      .map((cookie) => cookie!.split(";")[0])
      .join("; ");
    expect(getMfaRememberBrowserTokens("tenantId", header)).toEqual(["a", "b"]);
    expect(
      getMfaRememberBrowserTokens("tenantId", `${COOKIE_NAME}=c; other=x`),
    ).toEqual(["c"]);
  });
});
