import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
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

/** A token in the generated format (43 base64url characters), named for readability. */
function tok(name: string) {
  return createHash("sha256").update(name).digest("base64url");
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
    const token = tok("remembered-token");
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
    await storeToken(server.env, tok("old-token"));
    expectChallenged(await laterLogin(server, tok("old-token")));
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
      await storeToken(server.env, tok("issued-under-30-days"));
    } finally {
      vi.useRealTimers();
    }
    expectChallenged(await laterLogin(server, tok("issued-under-30-days")));

    // One issued within the lifetime still works.
    await storeToken(server.env, tok("fresh"));
    expectSkippedMfa(await laterLogin(server, tok("fresh")));
  });

  it("does not skip MFA for an expired token or another user's token", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await storeToken(server.env, tok("expired"), { expiresInMs: -1000 });
    await createOtherUser(server.env);
    await storeToken(server.env, tok("someone-else"), {
      userId: OTHER_USER_ID,
    });

    expectChallenged(await laterLogin(server, tok("expired")));
    expectChallenged(await laterLogin(server, tok("someone-else")));
    expectChallenged(await laterLogin(server, tok("never-issued")));
  });

  it("never skips enrollment for a user without a confirmed enrollment", async () => {
    const server = await setup({ allowRememberBrowser: true, enroll: false });
    await storeToken(server.env, tok("token"));

    const response = await laterLogin(server, tok("token"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/mfa/totp-enrollment");
  });

  it("keeps other users' tokens and replaces the user's own when remembering again", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await createOtherUser(server.env);
    await storeToken(server.env, tok("other-user-token"), {
      userId: OTHER_USER_ID,
    });
    await storeToken(server.env, tok("own-old-token"));
    const loginSession = await seedLoginAwaitingMfa(server.env);

    const code = await generateTOTP(decodeBase32(TOTP_SECRET));
    const response = await server.u2App.request(
      `/mfa/totp-challenge?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${COOKIE_NAME}=${tok("own-old-token")}.${tok("other-user-token")}`,
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
    expect(tokens[1]).toBe(tok("other-user-token"));
    expect(tokens).not.toContain(tok("own-old-token"));
  });

  it("bounds the tokens a padded cookie can make it look up", async () => {
    const server = await setup({ allowRememberBrowser: true });
    const padded = Array.from({ length: 200 }, (_, i) => tok(`junk-${i}`));

    const codes = server.env.data.codes;
    const get = codes.get.bind(codes);
    let lookups = 0;
    codes.get = async (tenantId, codeId, type) => {
      if (type === "mfa_remember_browser") lookups++;
      return get(tenantId, codeId, type);
    };
    try {
      expectChallenged(await laterLogin(server, padded.join(".")));
    } finally {
      codes.get = get;
    }
    // At most 10 candidate tokens plus the two invalidation marker slots.
    expect(lookups).toBeGreaterThan(0);
    expect(lookups).toBeLessThanOrEqual(12);
  });

  describe("invalidation markers across tenants", () => {
    /**
     * Make the codes adapter behave like drizzle's, whose primary key is
     * (code_id, code_type) without the tenant, and record every invalidation
     * marker id written.
     */
    function enforceTenantlessCodeKeys(env: TestEnv) {
      const codes = env.data.codes;
      const create = codes.create.bind(codes);
      const remove = codes.remove.bind(codes);
      const owners = new Map<string, string>();
      const markerIds: string[] = [];
      codes.create = async (tenantId, code) => {
        const key = `${code.code_id}\u0000${code.code_type}`;
        if (owners.has(key)) {
          throw new Error(`UNIQUE constraint failed: ${code.code_id}`);
        }
        const created = await create(tenantId, code);
        owners.set(key, tenantId);
        if (code.code_id.startsWith("user:")) markerIds.push(code.code_id);
        return created;
      };
      codes.remove = async (tenantId, codeId) => {
        for (const [key, owner] of owners) {
          if (owner === tenantId && key.startsWith(`${codeId}\u0000`)) {
            owners.delete(key);
          }
        }
        return remove(tenantId, codeId);
      };
      return markerIds;
    }

    const invalidateIn = (
      server: TestServer,
      tenantId: string,
      userId: string,
      token: string,
    ) =>
      server.managementApp.request(
        `/users/${encodeURIComponent(userId)}/multifactor/actions/invalidate-remember-browser`,
        {
          method: "POST",
          headers: { "tenant-id": tenantId, authorization: `Bearer ${token}` },
        },
        server.env,
      );

    it("invalidates the same user id in two tenants", async () => {
      const server = await setup({ allowRememberBrowser: true });
      const admin = await getAdminToken();
      await server.env.data.tenants.create({
        id: "otherTenant",
        friendly_name: "Other Tenant",
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
      await server.env.data.users.create("otherTenant", {
        user_id: USER_ID,
        email: "foo@example.com",
        email_verified: true,
        provider: "email",
        connection: "email",
        is_social: false,
      });
      const markerIds = enforceTenantlessCodeKeys(server.env);

      expect(
        (await invalidateIn(server, "tenantId", USER_ID, admin)).status,
      ).toBe(204);
      expect(
        (await invalidateIn(server, "otherTenant", USER_ID, admin)).status,
      ).toBe(204);
      expect(markerIds).toHaveLength(2);
      expect(new Set(markerIds).size).toBe(2);
    });

    it("keeps marker ids short enough for a 255-character user id", async () => {
      const server = await setup({ allowRememberBrowser: true });
      const admin = await getAdminToken();
      const longUserId = `auth0|${"x".repeat(249)}`;
      expect(longUserId).toHaveLength(255);
      await server.env.data.users.create("tenantId", {
        user_id: longUserId,
        email: "long@example.com",
        email_verified: true,
        provider: "auth0",
        connection: "Username-Password-Authentication",
        is_social: false,
      });
      const markerIds = enforceTenantlessCodeKeys(server.env);

      expect(
        (await invalidateIn(server, "tenantId", longUserId, admin)).status,
      ).toBe(204);
      expect(markerIds).toHaveLength(1);
      // kysely's code_id is varchar(255).
      expect(markerIds[0]!.length).toBeLessThanOrEqual(255);
      expect(markerIds[0]).not.toContain(longUserId);
    });
  });

  describe("replacing the invalidation marker", () => {
    const invalidate = (server: TestServer, token: string) =>
      server.managementApp.request(
        `/users/${encodeURIComponent(USER_ID)}/multifactor/actions/invalidate-remember-browser`,
        {
          method: "POST",
          headers: {
            "tenant-id": "tenantId",
            authorization: `Bearer ${token}`,
          },
        },
        server.env,
      );

    /** Tick past the millisecond so the next marker is strictly newer. */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

    it("keeps an earlier invalidation in force when writing the next marker fails", async () => {
      const server = await setup({ allowRememberBrowser: true });
      const admin = await getAdminToken();
      const revoked = tok("revoked-by-first-invalidation");
      await storeToken(server.env, revoked);

      expect((await invalidate(server, admin)).status).toBe(204);
      expectChallenged(await laterLogin(server, revoked));

      // The next invalidation can't write its marker.
      await tick();
      const codes = server.env.data.codes;
      const create = codes.create.bind(codes);
      codes.create = async (tenantId, code) => {
        if (code.code_id.startsWith("user:")) {
          throw new Error("write failed");
        }
        return create(tenantId, code);
      };
      try {
        // The failure surfaces (thrown here; a 5xx behind the error handler).
        const outcome = await invalidate(server, admin).then(
          (response) => response.status,
          () => "threw",
        );
        expect(outcome === "threw" || Number(outcome) >= 500).toBe(true);
      } finally {
        codes.create = create;
      }

      // The first invalidation must still reject the token.
      expectChallenged(await laterLogin(server, revoked));
    });

    it("treats a concurrent invalidation that wrote the same slot as success", async () => {
      const server = await setup({ allowRememberBrowser: true });
      const admin = await getAdminToken();
      const revoked = tok("revoked-by-concurrent-invalidations");
      await storeToken(server.env, revoked);
      await tick();

      // A second invalidation runs to completion while the first is about to
      // write the same slot, so the first one's write hits the duplicate key.
      const codes = server.env.data.codes;
      const create = codes.create.bind(codes);
      let concurrentStatus: number | undefined;
      codes.create = async (tenantId, code) => {
        if (
          code.code_id.startsWith("user:") &&
          concurrentStatus === undefined
        ) {
          concurrentStatus = 0;
          concurrentStatus = (await invalidate(server, admin)).status;
        }
        return create(tenantId, code);
      };
      let firstStatus: number;
      try {
        firstStatus = (await invalidate(server, admin)).status;
      } finally {
        codes.create = create;
      }

      expect(concurrentStatus).toBe(204);
      expect(firstStatus).toBe(204);
      expectChallenged(await laterLogin(server, revoked));
    });

    it("never leaves a window without the effective marker while replacing it", async () => {
      const server = await setup({ allowRememberBrowser: true });
      const admin = await getAdminToken();

      // Fill both marker slots, with a token issued between the two
      // invalidations: only the newer marker rejects it.
      expect((await invalidate(server, admin)).status).toBe(204);
      await tick();
      const revoked = tok("revoked-only-by-newer-marker");
      await storeToken(server.env, revoked);
      await tick();
      expect((await invalidate(server, admin)).status).toBe(204);
      expectChallenged(await laterLogin(server, revoked));

      // While the next marker is being written, a login with the revoked
      // token must still be challenged.
      await tick();
      const codes = server.env.data.codes;
      const create = codes.create.bind(codes);
      const duringWrite: Response[] = [];
      let probing = false;
      codes.create = async (tenantId, code) => {
        if (code.code_id.startsWith("user:") && !probing) {
          probing = true;
          try {
            duringWrite.push(await laterLogin(server, revoked));
          } finally {
            probing = false;
          }
        }
        return create(tenantId, code);
      };
      try {
        expect((await invalidate(server, admin)).status).toBe(204);
      } finally {
        codes.create = create;
      }

      expect(duringWrite).toHaveLength(1);
      expectChallenged(duringWrite[0]!);
      expectChallenged(await laterLogin(server, revoked));
    });
  });

  it("invalidates remembered browsers through the management API", async () => {
    const server = await setup({ allowRememberBrowser: true });
    await storeToken(server.env, tok("token"));
    expectSkippedMfa(await laterLogin(server, tok("token")));

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
    expectChallenged(await laterLogin(server, tok("token")));

    // A browser remembered after the invalidation works again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storeToken(server.env, tok("new-token"));
    expectSkippedMfa(await laterLogin(server, tok("new-token")));

    // Invalidating again is fine (replaces the marker).
    const again = await server.managementApp.request(
      `/users/${encodeURIComponent(USER_ID)}/multifactor/actions/invalidate-remember-browser`,
      { method: "POST", headers },
      server.env,
    );
    expect(again.status).toBe(204);
    expectChallenged(await laterLogin(server, tok("new-token")));

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
    await storeToken(server.env, tok("token"));

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
      `tenantId-auth-token=${session.id}; ${COOKIE_NAME}=${tok("token")}`,
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

      await storeToken(server.env, tok("token"));
      const response = await laterLogin(server, tok("token"));
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

      await storeToken(server.env, tok("token"));
      const response = await laterLogin(server, tok("token"));
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

  it("reads only generated-format tokens, and at most 10", () => {
    const many = Array.from({ length: 30 }, (_, i) => tok(`t${i}`));
    expect(
      getMfaRememberBrowserTokens(
        "tenantId",
        `${COOKIE_NAME}=${many.join(".")}`,
      ),
    ).toEqual(many.slice(0, 10));

    const valid = tok("valid");
    expect(
      getMfaRememberBrowserTokens(
        "tenantId",
        `${COOKIE_NAME}=short.${valid}.${"x".repeat(44)}.${valid.slice(0, 42)}!`,
      ),
    ).toEqual([valid]);
  });

  it("round-trips several tokens through the cookie, from both jars", () => {
    const [plain, partitioned] = serializeMfaRememberBrowserCookie(
      "tenantId",
      [tok("a"), tok("b")],
      60,
      "auth.example.com",
    );
    expect(partitioned).toContain("Partitioned");
    const header = [plain, partitioned]
      .map((cookie) => cookie!.split(";")[0])
      .join("; ");
    expect(getMfaRememberBrowserTokens("tenantId", header)).toEqual([
      tok("a"),
      tok("b"),
    ]);
    expect(
      getMfaRememberBrowserTokens(
        "tenantId",
        `${COOKIE_NAME}=${tok("c")}; other=x`,
      ),
    ).toEqual([tok("c")]);
  });
});
