import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  AuthorizationResponseType,
  CodeExecutor,
  LoginSessionState,
  LogTypes,
  decodeBase32,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../src/types";
import { OnExecutePostLogin } from "../../src/types/Hooks";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { getEnrichedClient } from "../../src/helpers/client";
import { createFrontChannelAuthResponse } from "../../src/authentication-flows/common";
import { mergeMfaRequest } from "../../src/hooks/post-user-login";
import { tenantPolicyRequiresMfa } from "../../src/authentication-flows/mfa";
import { flushBackgroundPromises } from "../../src/helpers/wait-until";
import { generateTOTP } from "../../src/utils/totp";

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const USER_ID = "email|userId";

type ApiCall = { method: string; args: unknown[] };

/** A code executor that records every run and replays the given API calls. */
function recordingExecutor(apiCalls: ApiCall[]) {
  const runs: string[] = [];
  const codeExecutor: CodeExecutor = {
    async execute(params) {
      runs.push(params.triggerId);
      return { success: true, durationMs: 1, apiCalls, logs: [] };
    },
  };
  return { codeExecutor, runs };
}

async function setup(options: {
  apiCalls?: ApiCall[];
  policy?: string[];
  onExecutePostLogin?: OnExecutePostLogin;
  /** SSO onto an existing browser session owned by this user that completed MFA. */
  mfaSessionUserId?: string;
}) {
  const { codeExecutor, runs } = recordingExecutor(options.apiCalls ?? []);
  const server = await getTestServer({
    mockEmail: true,
    testTenantLanguage: "en",
    codeExecutor,
  });
  const { env, managementApp } = server;
  const token = await getAdminToken();
  const headers = {
    "tenant-id": "tenantId",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  await managementApp.request(
    "/guardian/factors/otp",
    { method: "PUT", headers, body: JSON.stringify({ enabled: true }) },
    env,
  );
  if (options.policy) {
    await managementApp.request(
      "/guardian/policies",
      { method: "PUT", headers, body: JSON.stringify(options.policy) },
      env,
    );
  }

  await env.data.authenticationMethods.create("tenantId", {
    user_id: USER_ID,
    type: "totp",
    totp_secret: TOTP_SECRET,
    confirmed: true,
  });

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

  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid email profile",
      response_type: AuthorizationResponseType.CODE,
      state: "state",
      nonce: "nonce",
    },
  });

  let existingSessionIdToLink: string | undefined;
  if (options.mfaSessionUserId) {
    const now = Date.now();
    const session = await env.data.sessions.create("tenantId", {
      id: "mfaSession",
      user_id: options.mfaSessionUserId,
      login_session_id: "earlierLoginSession",
      device: {
        last_ip: "",
        initial_ip: "",
        last_user_agent: "",
        initial_user_agent: "",
        initial_asn: "",
        last_asn: "",
      },
      clients: ["clientId"],
      expires_at: new Date(now + 3600_000).toISOString(),
      idle_expires_at: new Date(now + 3600_000).toISOString(),
      authentication: {
        methods: [
          {
            name: "mfa",
            type: "totp",
            timestamp: new Date(now - 60_000).toISOString(),
          },
        ],
      },
    });
    existingSessionIdToLink = session.id;
  }

  // Drive the first pass (credentials accepted -> post-login hooks) the way a
  // login screen does, from inside a real Hono request.
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.post("/login", async (ctx) => {
    Object.assign(ctx.env, server.env);
    if (options.onExecutePostLogin) {
      ctx.env.hooks = { onExecutePostLogin: options.onExecutePostLogin };
    }
    ctx.set("tenant_id", "tenantId");
    ctx.set("client_id", "clientId");
    ctx.set("ip", "1.2.3.4");
    const client = await getEnrichedClient(ctx.env, "clientId");
    const user = await ctx.env.data.users.get("tenantId", USER_ID);
    if (!user) throw new Error("test user missing");
    const response = await createFrontChannelAuthResponse(ctx, {
      authParams: loginSession.authParams,
      client,
      user,
      loginSession,
      authStrategy: { strategy: "email", strategy_type: "passwordless" },
      existingSessionIdToLink,
    });
    await flushBackgroundPromises(ctx);
    return response;
  });

  const login = () =>
    app.request(
      "/login",
      { method: "POST", headers: { "tenant-id": "tenantId" } },
      env,
    );

  const submitTotp = async () => {
    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    return server.u2App.request(
      `/mfa/totp-challenge?state=${encodeURIComponent(loginSession.id)}`,
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
  };

  const successLogins = async () => {
    const { logs } = await env.data.logs.list("tenantId", {
      page: 0,
      per_page: 100,
      include_totals: true,
    });
    return logs.filter(
      (log) =>
        log.type === LogTypes.SUCCESS_LOGIN &&
        log.details?.login_session_id === loginSession.id,
    ).length;
  };

  const stateData = async () => {
    const current = await env.data.loginSessions.get(
      "tenantId",
      loginSession.id,
    );
    return {
      state: current?.state,
      data: current?.state_data ? JSON.parse(current.state_data) : {},
    };
  };

  return {
    server,
    env,
    runs,
    loginSession,
    login,
    submitTotp,
    successLogins,
    stateData,
  };
}

describe("post-login api.multifactor.enable (issue #1670)", () => {
  it("challenges the user when an action requires MFA and the tenant policy is never", async () => {
    const t = await setup({
      apiCalls: [
        {
          method: "multifactor.enable",
          args: ["any", { allowRememberBrowser: true }],
        },
      ],
    });

    const first = await t.login();
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(
      `/u/continue?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    const afterHooks = await t.stateData();
    expect(afterHooks.state).toBe(LoginSessionState.AWAITING_CONTINUATION);
    expect(afterHooks.data.mfa_required_by_action).toEqual({
      provider: "any",
      allow_remember_browser: true,
    });

    // /u/continue resumes the login; the MFA check now requires MFA.
    const resumed = await t.server.universalApp.request(
      `/continue?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.status).toBe(302);
    expect(resumed.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    expect((await t.stateData()).state).toBe(LoginSessionState.AWAITING_MFA);

    const done = await t.submitTotp();
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect(done.headers.get("location")).toContain("code=");

    // Post-login hooks ran exactly once for the whole login.
    expect(t.runs).toEqual(["post-user-login"]);
    expect(await t.successLogins()).toBe(1);
  });

  it("does not challenge when no action requires MFA and the policy is never", async () => {
    const t = await setup({ apiCalls: [] });

    const response = await t.login();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect(t.runs).toEqual(["post-user-login"]);
  });

  it('ignores api.multifactor.enable("none") instead of skipping MFA', async () => {
    const t = await setup({
      apiCalls: [{ method: "multifactor.enable", args: ["none"] }],
    });
    const response = await t.login();
    expect(response.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect((await t.stateData()).data.mfa_required_by_action).toBeUndefined();
  });

  it('does not let "none" remove MFA required by the tenant policy', async () => {
    const t = await setup({
      policy: ["all-applications"],
      apiCalls: [{ method: "multifactor.enable", args: ["none"] }],
    });
    const response = await t.login();
    expect(response.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    // The policy challenge happens before hooks run.
    expect(t.runs).toEqual([]);

    const done = await t.submitTotp();
    expect(done.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect(t.runs).toEqual(["post-user-login"]);
  });

  it("does not challenge twice when the tenant policy already required MFA", async () => {
    const t = await setup({
      policy: ["all-applications"],
      apiCalls: [{ method: "multifactor.enable", args: ["any"] }],
    });
    const first = await t.login();
    expect(first.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );

    // Completing the policy challenge runs the hooks; the action's request is
    // already satisfied, so the login completes.
    const done = await t.submitTotp();
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect(t.runs).toEqual(["post-user-login"]);
    expect(await t.successLogins()).toBe(1);
  });

  it("honours api.multifactor.enable from the env onExecutePostLogin hook", async () => {
    let calls = 0;
    const t = await setup({
      onExecutePostLogin: async (_event, api) => {
        calls++;
        api.multifactor.enable("google-authenticator");
      },
    });

    const first = await t.login();
    expect(first.headers.get("location")).toBe(
      `/u/continue?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    expect((await t.stateData()).data.mfa_required_by_action).toEqual({
      provider: "google-authenticator",
      allow_remember_browser: false,
    });

    const resumed = await t.server.universalApp.request(
      `/continue?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    const done = await t.submitTotp();
    expect(done.headers.get("location")).toContain(
      "https://example.com/callback",
    );
    expect(calls).toBe(1);
  });
});

describe("action-required MFA cannot be bypassed (issue #1670 review)", () => {
  it("refuses /authorize/resume while the MFA continuation is pending", async () => {
    const t = await setup({
      apiCalls: [{ method: "multifactor.enable", args: ["any"] }],
    });
    const first = await t.login();
    expect(first.headers.get("location")).toBe(
      `/u/continue?state=${encodeURIComponent(t.loginSession.id)}`,
    );

    const resumed = await t.server.oauthApp.request(
      `/authorize/resume?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.status).toBe(403);
    expect(resumed.headers.get("location") ?? "").not.toContain("code=");
    expect((await t.stateData()).state).not.toBe(LoginSessionState.COMPLETED);

    // The legitimate path still works afterwards.
    const viaContinue = await t.server.universalApp.request(
      `/continue?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(viaContinue.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );
  });

  it("challenges and issues for the primary when a hook linked the account", async () => {
    const PRIMARY_ID = "email|primaryUser";
    const t = await setup({
      onExecutePostLogin: async (event, api) => {
        await event.ctx.env.data.users.update("tenantId", USER_ID, {
          linked_to: PRIMARY_ID,
        });
        api.multifactor.enable("any");
      },
    });
    const now = new Date().toISOString();
    await t.env.data.users.create("tenantId", {
      user_id: PRIMARY_ID,
      email: "primary@example.com",
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
      created_at: now,
      updated_at: now,
      login_count: 0,
    });
    // Only the primary has a factor: a challenge built from the secondary
    // would send the user to enrollment instead.
    const { authenticationMethods } = t.env.data;
    for (const method of await authenticationMethods.list(
      "tenantId",
      USER_ID,
    )) {
      await authenticationMethods.remove("tenantId", method.id);
    }
    await authenticationMethods.create("tenantId", {
      user_id: PRIMARY_ID,
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });

    await t.login();
    const resumed = await t.server.universalApp.request(
      `/continue?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );

    const done = await t.submitTotp();
    const location = new URL(done.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://example.com/callback",
    );
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    const stored = await t.env.data.codes.get(
      "tenantId",
      code ?? "",
      "authorization_code",
    );
    expect(stored?.user_id).toBe(PRIMARY_ID);
  });
});

describe("action-required MFA on a session that completed MFA (#1668)", () => {
  it("issues without a 403 or an extra redirect for the same user", async () => {
    const t = await setup({
      apiCalls: [{ method: "multifactor.enable", args: ["any"] }],
      mfaSessionUserId: USER_ID,
    });
    const response = await t.login();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://example.com/callback",
    );
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(t.runs).toEqual(["post-user-login"]);
  });

  it("lets a resumed login through when the hook redirected and the session completed MFA", async () => {
    // The env hook requires MFA and also redirects, so the requirement is
    // stored and enforced on resume, where the session's MFA satisfies it.
    const t = await setup({
      mfaSessionUserId: USER_ID,
      onExecutePostLogin: async (_event, api) => {
        api.multifactor.enable("any");
        api.redirect.sendUserTo("https://hook.example.com/step");
      },
    });
    const first = await t.login();
    expect(first.headers.get("location")).toContain(
      "https://hook.example.com/step",
    );
    expect((await t.stateData()).data.mfa_required_by_action).toBeTruthy();

    const resumed = await t.server.oauthApp.request(
      `/authorize/resume?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.status).toBe(302);
    const location = new URL(resumed.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://example.com/callback",
    );
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  it("refuses that resumed login when the session never completed MFA", async () => {
    const t = await setup({
      onExecutePostLogin: async (_event, api) => {
        api.multifactor.enable("any");
        api.redirect.sendUserTo("https://hook.example.com/step");
      },
    });
    await t.login();
    const resumed = await t.server.oauthApp.request(
      `/authorize/resume?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.status).toBe(403);
  });

  it("still challenges when a hook linked the user to a different primary", async () => {
    // The session's MFA was completed by the secondary identity; linked
    // identities don't inherit it (#1668), so the primary is challenged.
    const PRIMARY_ID = "email|primaryUser";
    const t = await setup({
      mfaSessionUserId: USER_ID,
      onExecutePostLogin: async (event, api) => {
        await event.ctx.env.data.users.update("tenantId", USER_ID, {
          linked_to: PRIMARY_ID,
        });
        api.multifactor.enable("any");
      },
    });
    const now = new Date().toISOString();
    await t.env.data.users.create("tenantId", {
      user_id: PRIMARY_ID,
      email: "primary@example.com",
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
      created_at: now,
      updated_at: now,
      login_count: 0,
    });
    await t.env.data.authenticationMethods.create("tenantId", {
      user_id: PRIMARY_ID,
      type: "totp",
      totp_secret: TOTP_SECRET,
      confirmed: true,
    });

    const response = await t.login();
    expect(response.headers.get("location")).toBe(
      `/u/continue?state=${encodeURIComponent(t.loginSession.id)}`,
    );
    const resumed = await t.server.universalApp.request(
      `/continue?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(resumed.headers.get("location")).toBe(
      `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
    );

    // Skipping the challenge through /authorize/resume is still refused.
    const bypass = await t.server.oauthApp.request(
      `/authorize/resume?state=${encodeURIComponent(t.loginSession.id)}`,
      { method: "GET", headers: { "tenant-id": "tenantId" } },
      t.env,
    );
    expect(bypass.headers.get("location") ?? "").not.toContain("code=");
  });
});

describe("mergeMfaRequest", () => {
  it("defaults a missing or invalid provider to any", () => {
    expect(mergeMfaRequest(undefined, undefined, undefined)).toEqual({
      provider: "any",
      allow_remember_browser: false,
    });
    expect(mergeMfaRequest(undefined, 42, undefined)?.provider).toBe("any");
  });

  it('keeps an earlier request when a later action passes "none"', () => {
    const first = mergeMfaRequest(undefined, "any", {
      allowRememberBrowser: true,
    });
    expect(mergeMfaRequest(first, "none", undefined)).toEqual(first);
    expect(mergeMfaRequest(undefined, "none", undefined)).toBeUndefined();
  });

  it("only allows remembering the browser when every enabling call allows it", () => {
    const first = mergeMfaRequest(undefined, "any", {
      allowRememberBrowser: true,
    });
    const second = mergeMfaRequest(first, "duo", {});
    expect(second).toEqual({ provider: "duo", allow_remember_browser: false });
    expect(
      mergeMfaRequest(second, "any", { allowRememberBrowser: true })
        ?.allow_remember_browser,
    ).toBe(false);
  });
});

describe("tenant MFA policy values", () => {
  it("requires MFA for always, all-applications and confidence-score", () => {
    expect(tenantPolicyRequiresMfa("always")).toBe(true);
    expect(tenantPolicyRequiresMfa("all-applications")).toBe(true);
    // Adaptive MFA is not supported: never skip MFA on a score we can't compute.
    expect(tenantPolicyRequiresMfa("confidence-score")).toBe(true);
    expect(tenantPolicyRequiresMfa("never")).toBe(false);
    expect(tenantPolicyRequiresMfa(undefined)).toBe(false);
  });

  it.each(["all-applications", "confidence-score"] as const)(
    "challenges a login when the stored policy is %s",
    async (policy) => {
      const t = await setup({});
      await t.env.data.tenants.update("tenantId", {
        mfa: { policy, factors: { otp: true } },
      });
      const response = await t.login();
      expect(response.headers.get("location")).toBe(
        `/u2/mfa/totp-challenge?state=${encodeURIComponent(t.loginSession.id)}`,
      );
    },
  );
});
