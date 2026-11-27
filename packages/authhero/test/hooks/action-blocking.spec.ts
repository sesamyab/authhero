import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import { nanoid } from "nanoid";
import {
  ActionExecutionInsert,
  AuthorizationResponseType,
  CodeExecutionResult,
  CodeExecutor,
  LoginSessionState,
  LogTypes,
  Strategy,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { createTestRefreshToken } from "../helpers/refresh-token";
import { getEnrichedClient } from "../../src/helpers/client";
import { createFrontChannelAuthResponse } from "../../src/authentication-flows/common";
import { executeCodeHook } from "../../src/hooks/codehooks";
import { flushBackgroundPromises } from "../../src/helpers/wait-until";
import { parseJWT } from "../../src/utils/jwt";
import {
  computeCodeChallenge,
  generateCodeVerifier,
} from "../../src/utils/crypto";

// Issue #1816: actions must be able to block a login.

const USER_ID = "email|userId";

type Behaviour = () => Promise<CodeExecutionResult>;

const recorded = (
  ...apiCalls: Array<{ method: string; args: unknown[] }>
): Behaviour => {
  return async () => ({ success: true, durationMs: 1, apiCalls, logs: [] });
};
const failed: Behaviour = async () => ({
  success: false,
  error: "boom",
  durationMs: 1,
  apiCalls: [],
});

/** An executor that runs the scripted behaviour for each trigger. */
function scriptedExecutor(behaviours: Record<string, Behaviour>) {
  const codeExecutor: CodeExecutor = {
    async execute(params) {
      const behaviour = behaviours[params.triggerId];
      if (!behaviour) {
        return { success: true, durationMs: 1, apiCalls: [], logs: [] };
      }
      return behaviour();
    },
  };
  return codeExecutor;
}

async function setup(
  behaviours: Record<string, Behaviour>,
  binding: { metadata?: Record<string, unknown> } = {},
) {
  const server = await getTestServer({
    codeExecutor: scriptedExecutor(behaviours),
  });
  const { env } = server;
  for (const trigger_id of Object.keys(behaviours)) {
    const action = await env.data.actions.create("tenantId", {
      name: `${trigger_id}-action`,
      code: "exports.handler = async () => {};",
    });
    await env.data.hooks.create("tenantId", {
      trigger_id,
      enabled: true,
      code_id: action.id,
      synchronous: true,
      ...(binding.metadata ? { metadata: binding.metadata } : {}),
    });
  }
  // The adapter has no list method; capture what gets stored.
  const stored: ActionExecutionInsert[] = [];
  const create = env.data.actionExecutions.create;
  env.data.actionExecutions.create = (tenantId, execution) => {
    stored.push(execution);
    return create(tenantId, execution);
  };
  return Object.assign(server, { executions: stored });
}

/** The execution records stored for a trigger (Auth0 trigger id). */
function executions(
  server: Awaited<ReturnType<typeof setup>>,
  triggerId: string,
) {
  return server.executions.filter((e) => e.trigger_id === triggerId);
}

/** Exchange a freshly minted authorization code for USER_ID. */
async function exchangeCode(
  server: Awaited<ReturnType<typeof getTestServer>>,
  loginSessionId?: string,
) {
  const { env, oauthApp } = server;
  const loginId =
    loginSessionId ??
    (
      await env.data.loginSessions.create("tenantId", {
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        csrf_token: nanoid(),
        authParams: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          scope: "openid",
          audience: "https://example.com",
        },
        user_id: USER_ID,
      })
    ).id;
  const codeVerifier = generateCodeVerifier();
  const code = await env.data.codes.create("tenantId", {
    code_id: nanoid(32),
    code_type: "authorization_code",
    login_id: loginId,
    expires_at: new Date(Date.now() + 300 * 1000).toISOString(),
    user_id: USER_ID,
    redirect_uri: "https://example.com/callback",
    code_challenge: await computeCodeChallenge(codeVerifier, "S256"),
    code_challenge_method: "S256",
  });
  return testClient(oauthApp, env).oauth.token.$post(
    {
      form: {
        grant_type: "authorization_code",
        client_id: "clientId",
        code: code.code_id,
        redirect_uri: "https://example.com/callback",
        code_verifier: codeVerifier,
      },
    },
    { headers: { "tenant-id": "tenantId" } },
  );
}

async function exchangeRefreshToken(
  server: Awaited<ReturnType<typeof getTestServer>>,
) {
  const { env, oauthApp } = server;
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: nanoid(),
    authParams: { client_id: "clientId", scope: "openid" },
    user_id: USER_ID,
  });
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  const { wireToken } = await createTestRefreshToken(env, "tenantId", {
    id: nanoid(),
    login_id: loginSession.id,
    user_id: USER_ID,
    client_id: "clientId",
    resource_servers: [{ audience: "https://example.com", scopes: "openid" }],
    device: {
      last_ip: "",
      initial_ip: "",
      last_user_agent: "",
      initial_user_agent: "",
      initial_asn: "",
      last_asn: "",
    },
    rotating: false,
    idle_expires_at: expires,
    expires_at: expires,
  });
  return testClient(oauthApp, env).oauth.token.$post(
    // @ts-expect-error - testClient type requires both form and json
    {
      form: {
        grant_type: "refresh_token",
        refresh_token: wireToken,
        client_id: "clientId",
      },
    },
    { headers: { "tenant-id": "tenantId" } },
  );
}

/** Complete a login for USER_ID the way a login screen does. */
async function login(
  server: Awaited<ReturnType<typeof getTestServer>>,
  options: {
    responseType?: AuthorizationResponseType;
    stateData?: Record<string, unknown>;
  } = {},
) {
  const { env } = server;
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid email",
      response_type: options.responseType ?? AuthorizationResponseType.CODE,
      state: "state",
      nonce: "nonce",
    },
    ...(options.stateData
      ? { state_data: JSON.stringify(options.stateData) }
      : {}),
  });
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.post("/login", async (ctx) => {
    Object.assign(ctx.env, server.env);
    ctx.set("tenant_id", "tenantId");
    ctx.set("client_id", "clientId");
    ctx.set("ip", "1.2.3.4");
    const client = await getEnrichedClient(ctx.env, "clientId");
    const user = await ctx.env.data.users.get("tenantId", USER_ID);
    if (!user) throw new Error("test user missing");
    try {
      return await createFrontChannelAuthResponse(ctx, {
        authParams: loginSession.authParams,
        client,
        user,
        loginSession,
        authStrategy: { strategy: "email", strategy_type: "passwordless" },
      });
    } finally {
      await flushBackgroundPromises(ctx);
    }
  });
  const response = await app.request(
    "/login",
    { method: "POST", headers: { "tenant-id": "tenantId" } },
    env,
  );
  const current = await env.data.loginSessions.get("tenantId", loginSession.id);
  return { response, loginSession: current };
}

async function loginLogTypes(
  env: Awaited<ReturnType<typeof getTestServer>>["env"],
) {
  const { logs } = await env.data.logs.list("tenantId", {
    page: 0,
    per_page: 100,
    include_totals: true,
  });
  return logs.map((log) => log.type);
}

async function signup(server: Awaited<ReturnType<typeof getTestServer>>) {
  const token = await getAdminToken();
  return testClient(server.managementApp, server.env).users.$post(
    {
      json: {
        email: `signup-${nanoid()}@example.com`,
        connection: Strategy.USERNAME_PASSWORD,
      },
      header: { "tenant-id": "tenantId" },
    },
    { headers: { authorization: `Bearer ${token}` } },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("credentials-exchange actions", () => {
  const deny = recorded({
    method: "access.deny",
    args: ["not_a_member", "No membership"],
  });

  it("api.access.deny stops the authorization_code exchange", async () => {
    const server = await setup({ "credentials-exchange": deny });
    const response = await exchangeCode(server);

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("not_a_member");
    expect(body).not.toContain("access_token");
    const [execution] = executions(server, "credentials-exchange");
    expect(execution?.status).toBe("canceled");
  });

  it("api.access.deny stops the refresh_token exchange", async () => {
    const server = await setup({ "credentials-exchange": deny });
    const response = await exchangeRefreshToken(server);

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("access_token");
  });

  it("a failed action still lets the exchange through by default", async () => {
    const server = await setup({ "credentials-exchange": failed });
    const response = await exchangeCode(server);

    expect(response.status).toBe(200);
  });

  it("a failed action denies the exchange with fail_closed", async () => {
    const server = await setup(
      { "credentials-exchange": failed },
      { metadata: { fail_closed: true } },
    );
    const response = await exchangeCode(server);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("action_failed");
    const [execution] = executions(server, "credentials-exchange");
    expect(execution?.status).toBe("canceled");
  });

  it("an executor that throws a plain Error denies with fail_closed", async () => {
    const server = await setup(
      {
        "credentials-exchange": async () => {
          throw new Error("executor crashed");
        },
      },
      { metadata: { fail_closed: true } },
    );
    const response = await exchangeCode(server);

    expect(response.status).toBe(400);
  });

  it("a timed-out action denies the exchange with fail_closed", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const server = await setup(
      {
        "credentials-exchange": () => {
          started();
          return new Promise<CodeExecutionResult>(() => {});
        },
      },
      { metadata: { fail_closed: true } },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = exchangeCode(server);
    await running;
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("action_timeout");
  });
});

describe("post-user-login actions", () => {
  it("api.access.deny fails the login", async () => {
    const server = await setup({
      "post-user-login": recorded({
        method: "access.deny",
        args: ["Members only"],
      }),
    });
    const { response, loginSession } = await login(server);

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toEqual({
      error: "access_denied",
      error_description: "Members only",
    });
    expect(loginSession?.state).toBe(LoginSessionState.FAILED);
    const types = await loginLogTypes(server.env);
    expect(types).toContain(LogTypes.FAILED_LOGIN);
    expect(types).not.toContain(LogTypes.SUCCESS_LOGIN);
    const [execution] = executions(server, "post-login");
    expect(execution?.status).toBe("canceled");
  });

  it("applies setCustomClaim to the tokens of the authorization-code exchange", async () => {
    const server = await setup({
      "post-user-login": recorded(
        { method: "idToken.setCustomClaim", args: ["member", true] },
        { method: "accessToken.setCustomClaim", args: ["plan", "pro"] },
        // Reserved claims stay owned by the server.
        { method: "idToken.setCustomClaim", args: ["sub", "forged"] },
      ),
    });
    const { response, loginSession } = await login(server);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("code=");

    const tokens = await exchangeCode(server, loginSession!.id);
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as {
      access_token: string;
      id_token: string;
    };
    const idToken = parseJWT(body.id_token)?.payload;
    expect(idToken).toMatchObject({ member: true, sub: USER_ID });
    expect(parseJWT(body.access_token)?.payload).toMatchObject({
      plan: "pro",
    });
  });

  it("does not reapply claims an earlier run left on the login session", async () => {
    // This run sets no claims; the session still holds an earlier run's.
    const server = await setup({ "post-user-login": recorded() });
    const { response, loginSession } = await login(server, {
      responseType: AuthorizationResponseType.ID_TOKEN,
      stateData: {
        action_claims: { user_id: USER_ID, id_token: { stale: true } },
      },
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    const idToken = new URLSearchParams(location.hash.slice(1)).get("id_token");
    expect(idToken).toBeTruthy();
    expect(parseJWT(idToken!)?.payload).not.toHaveProperty("stale");
    expect(JSON.parse(loginSession!.state_data || "{}")).not.toHaveProperty(
      "action_claims",
    );
  });

  it("fails the login when the claims can't be stored for the code exchange", async () => {
    const server = await setup({
      "post-user-login": recorded({
        method: "idToken.setCustomClaim",
        args: ["member", true],
      }),
    });
    const update = server.env.data.loginSessions.update;
    server.env.data.loginSessions.update = async (tenantId, id, session) =>
      session.state_data?.includes("action_claims")
        ? false
        : update(tenantId, id, session);
    const { response } = await login(server);

    expect(response.status).toBe(500);
    expect(response.headers.get("location") ?? "").not.toContain("code=");
  });

  it("does not apply post-login claims to another login's exchange", async () => {
    const server = await setup({
      "post-user-login": recorded({
        method: "idToken.setCustomClaim",
        args: ["member", true],
      }),
    });
    await login(server);
    const tokens = await exchangeCode(server);
    const body = (await tokens.json()) as { id_token: string };
    expect(parseJWT(body.id_token)?.payload).not.toHaveProperty("member");
  });

  it("reports redirect.sendUserTo as unsupported instead of dropping it", async () => {
    const server = await setup({
      "post-user-login": recorded({
        method: "redirect.sendUserTo",
        args: ["https://example.com/elsewhere"],
      }),
    });
    const { response } = await login(server);

    expect(response.status).toBe(302);
    const [execution] = executions(server, "post-login");
    expect(execution?.status).toBe("partial");
    expect(execution?.results[0]?.error).toMatchObject({
      id: "unsupported_api",
    });
  });

  it("a failed action still lets the login through by default", async () => {
    const server = await setup({ "post-user-login": failed });
    const { response } = await login(server);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("code=");
  });

  it("a failed action fails the login with fail_closed", async () => {
    const server = await setup(
      { "post-user-login": failed },
      { metadata: { fail_closed: true } },
    );
    const { response, loginSession } = await login(server);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "access_denied",
      error_description: "action_failed",
    });
    expect(loginSession?.state).toBe(LoginSessionState.FAILED);
  });
});

describe("pre-user-registration actions", () => {
  it("a failed action still lets the signup through by default", async () => {
    const server = await setup({ "pre-user-registration": failed });
    const response = await signup(server);

    expect(response.status).toBe(201);
  });

  it("a failed action denies the signup with fail_closed", async () => {
    const server = await setup(
      { "pre-user-registration": failed },
      { metadata: { fail_closed: true } },
    );
    const response = await signup(server);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("action_failed");
  });
});

describe("executeCodeHook", () => {
  it("marks a timeout as action_timeout and a failure as action_failed", async () => {
    const server = await getTestServer();
    const action = await server.env.data.actions.create("tenantId", {
      name: "slow",
      code: "exports.handler = async () => {};",
    });
    const run = (codeExecutor: CodeExecutor) =>
      executeCodeHook({
        codeExecutor,
        data: server.env.data,
        tenantId: "tenantId",
        hook: { code_id: action.id },
        event: {},
        triggerId: "credentials-exchange",
        api: {},
      });

    const failure = await run({ execute: failed });
    expect(failure.failure).toBe("action_failed");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const pending = run({
      execute: () => {
        started();
        return new Promise<CodeExecutionResult>(() => {});
      },
    });
    await running;
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).failure).toBe("action_timeout");
  });
});
