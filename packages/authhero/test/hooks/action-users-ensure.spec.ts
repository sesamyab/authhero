import { describe, it, expect } from "vitest";
import { Context, Hono } from "hono";
import { testClient } from "hono/testing";
import {
  LogTypes,
  Strategy,
  User,
  UserResponse,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { addDataHooks, postUserLoginHook } from "../../src/hooks";
import {
  createActionUsersApi,
  createExternalConnectionLookup,
  MAX_ENSURED_USERS_PER_EXECUTION,
} from "../../src/hooks/helpers/action-users";
import { createPostLoginUserApi } from "../../src/hooks/helpers/post-login-account-linking";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { flushBackgroundPromises } from "../../src/helpers/wait-until";
import { getEnrichedClient, EnrichedClient } from "../../src/helpers/client";
import { USERNAME_PASSWORD_PROVIDER } from "../../src/constants";

const tenantId = "tenantId";
const ANCHOR = "parat|214700";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

function createMockCtx(env: Bindings): Ctx {
  const vars: Record<string, unknown> = {
    tenant_id: tenantId,
    ip: "127.0.0.1",
  };
  // Hand-rolled partial context — narrow through `unknown` since it only
  // implements the members these tests exercise.
  return {
    req: {
      method: "POST",
      url: "http://test",
      path: "/test",
      header: (name?: string) => (name === "tenant-id" ? tenantId : undefined),
      query: () => undefined,
      raw: { headers: new Headers() },
    },
    env,
    var: vars,
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Ctx;
}

async function createExternalConnection(
  env: Bindings,
  name = "parat",
  options: Record<string, unknown> = { allow_action_users: true },
  strategy: string = Strategy.EXTERNAL,
) {
  await env.data.connections.create(tenantId, {
    id: `conn-${name}`,
    name,
    strategy,
    options,
  });
}

async function hookLogs(env: Bindings, ctx?: Ctx) {
  if (ctx) await flushBackgroundPromises(ctx);
  const { logs } = await env.data.logs.list(tenantId, {
    page: 0,
    per_page: 100,
    include_totals: false,
  });
  return logs.filter(
    (l) => l.type === LogTypes.FAILED_HOOK || l.type === LogTypes.SUCCESS_HOOK,
  );
}

async function allUserIds(env: Bindings) {
  const { users } = await env.data.users.list(tenantId, {
    page: 0,
    per_page: 100,
    include_totals: false,
  });
  return users.map((u) => u.user_id).sort();
}

function reasonsOf(logs: Awaited<ReturnType<typeof hookLogs>>) {
  return logs
    .filter((l) => l.type === LogTypes.FAILED_HOOK)
    .map((l) => (l.details as { reason?: string } | undefined)?.reason);
}

async function setupEnsure(triggerId = "post-user-login") {
  const { env } = await getTestServer();
  const ctx = createMockCtx(env);
  const usersApi = createActionUsersApi({
    ctx,
    data: env.data,
    tenantId,
    triggerId,
    externalConnections: createExternalConnectionLookup(env.data, tenantId),
  });
  return { env, ctx, usersApi };
}

describe("api.users.ensure guards", () => {
  const cases: Array<{
    name: string;
    setup: (env: Bindings) => Promise<void>;
    params: unknown;
    reason: string;
  }> = [
    {
      name: "missing connection",
      setup: async () => {},
      params: { connection: "parat", id: "214700" },
      reason: "connection_not_allowed",
    },
    {
      name: "wrong strategy",
      setup: (env) =>
        createExternalConnection(
          env,
          "parat",
          { allow_action_users: true },
          Strategy.OIDC,
        ),
      params: { connection: "parat", id: "214700" },
      reason: "connection_not_allowed",
    },
    {
      name: "flag off",
      setup: (env) => createExternalConnection(env, "parat", {}),
      params: { connection: "parat", id: "214700" },
      reason: "connection_not_allowed",
    },
    {
      name: "reserved connection name",
      setup: (env) => createExternalConnection(env, "sms"),
      params: { connection: "sms", id: "214700" },
      reason: "connection_not_allowed",
    },
    {
      name: "id containing a pipe",
      setup: (env) => createExternalConnection(env),
      params: { connection: "parat", id: "21|4700" },
      reason: "invalid_id",
    },
    {
      name: "blank id",
      setup: (env) => createExternalConnection(env),
      params: { connection: "parat", id: "  " },
      reason: "invalid_id",
    },
    {
      name: "non-object params",
      setup: (env) => createExternalConnection(env),
      params: "parat|214700",
      reason: "invalid_params",
    },
  ];

  for (const c of cases) {
    it(`refuses and writes nothing: ${c.name}`, async () => {
      const { env, ctx, usersApi } = await setupEnsure();
      await c.setup(env);

      const before = await allUserIds(env);
      await usersApi.api.users.ensure(c.params);

      expect(await allUserIds(env)).toEqual(before);
      expect(usersApi.ensuredUserIds.size).toBe(0);
      expect(reasonsOf(await hookLogs(env, ctx))).toEqual([c.reason]);
    });
  }

  it(`caps an execution at ${MAX_ENSURED_USERS_PER_EXECUTION} calls`, async () => {
    const { env, ctx, usersApi } = await setupEnsure();
    await createExternalConnection(env);

    for (let i = 0; i <= MAX_ENSURED_USERS_PER_EXECUTION; i++) {
      await usersApi.api.users.ensure({ connection: "parat", id: `m${i}` });
    }

    expect(usersApi.ensuredUserIds.size).toBe(MAX_ENSURED_USERS_PER_EXECUTION);
    expect(
      await env.data.users.get(
        tenantId,
        `parat|m${MAX_ENSURED_USERS_PER_EXECUTION}`,
      ),
    ).toBeNull();
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual(["too_many_users"]);
  });
});

describe("api.users.ensure upsert", () => {
  it("creates the anchor once, then merges non-blank profile fields and app_metadata", async () => {
    const { env, ctx, usersApi } = await setupEnsure();
    await createExternalConnection(env);

    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { email: "Ada@Example.com", given_name: "Ada", user_id: "x" },
      app_metadata: { roles: ["member"], region: "north" },
    });

    const created = await env.data.users.get(tenantId, ANCHOR);
    expect(created).toMatchObject({
      user_id: ANCHOR,
      provider: "parat",
      connection: "parat",
      is_social: false,
      email: "ada@example.com",
      email_verified: false,
      given_name: "Ada",
      app_metadata: { roles: ["member"], region: "north" },
    });

    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { given_name: "", family_name: "Lovelace" },
      app_metadata: { roles: ["board"] },
    });

    const merged = await env.data.users.get(tenantId, ANCHOR);
    expect(merged).toMatchObject({
      given_name: "Ada",
      family_name: "Lovelace",
      app_metadata: { roles: ["board"], region: "north" },
    });
    expect(usersApi.ensuredUserIds).toEqual(new Set([ANCHOR]));

    const logs = await hookLogs(env, ctx);
    expect(
      logs
        .filter((l) => l.type === LogTypes.SUCCESS_HOOK)
        .map((l) => (l.details as { outcome?: string }).outcome),
    ).toEqual(expect.arrayContaining(["created", "updated"]));
  });

  it("does not run registration hooks or demote the anchor by email linking", async () => {
    let registrationHookCalls = 0;
    const { env } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async () => {
          registrationHookCalls++;
        },
      },
    });
    const ctx = createMockCtx(env);
    await createExternalConnection(env);
    // An older, unlinked, verified user with the address the anchor will get.
    await env.data.users.create(tenantId, {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|older`,
      email: "shared@example.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });

    // Decorated, as the triggers receive it.
    const data = addDataHooks(ctx, env.data);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections: createExternalConnectionLookup(data, tenantId),
    });
    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { email: "shared@example.com", email_verified: true },
    });

    expect(registrationHookCalls).toBe(0);
    const anchor = await env.data.users.get(tenantId, ANCHOR);
    expect(anchor?.email).toBe("shared@example.com");
    expect(anchor?.linked_to).toBeFalsy();
  });
});

describe("pre-user-registration: ensure + setLinkedTo", () => {
  async function setupRegistration(code: string) {
    const { env, managementApp } = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
    });
    await createExternalConnection(env);
    const action = await env.data.actions.create(tenantId, {
      name: "parat-anchor",
      code,
    });
    await env.data.hooks.create(tenantId, {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const register = (email: string, connection: string) =>
      client.users.$post(
        {
          json: { email, connection },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
    return { env, register };
  }

  it("creates the anchor once and links every new identity under it", async () => {
    const { env, register } = await setupRegistration(`
exports.onExecutePreUserRegistration = async (event, api) => {
  api.users.ensure({
    connection: "parat",
    id: "214700",
    profile: { given_name: "Ada" },
  });
  api.user.setLinkedTo("parat|214700");
};
`);

    const first = await register("ada@example.com", Strategy.EMAIL);
    expect(first.status).toBe(201);
    const second = await register("ada@example.com", "google-oauth2");
    expect(second.status).toBe(201);

    const anchor = await env.data.users.get(tenantId, ANCHOR);
    expect(anchor?.given_name).toBe("Ada");
    expect(anchor?.linked_to).toBeFalsy();

    const { users: linked } = await env.data.users.list(tenantId, {
      q: `linked_to:${ANCHOR}`,
    });
    expect(linked.map((u) => u.connection).sort()).toEqual([
      Strategy.EMAIL,
      "google-oauth2",
    ]);

    const { users: anchors } = await env.data.users.list(tenantId, {
      q: "provider:parat",
    });
    expect(anchors.filter((u) => u.connection === "parat")).toHaveLength(1);
  });

  it("registers the user unlinked when setLinkedTo names a user that does not exist", async () => {
    const { env, register } = await setupRegistration(`
exports.onExecutePreUserRegistration = async (event, api) => {
  api.user.setLinkedTo("parat|missing");
};
`);

    const response = await register("lone@example.com", Strategy.EMAIL);
    expect(response.status).toBe(201);
    const created = (await response.json()) as UserResponse;
    expect(created.user_id.startsWith("email|")).toBe(true);
    const stored = await env.data.users.get(tenantId, created.user_id);
    expect(stored?.linked_to).toBeFalsy();

    const { logs } = await env.data.logs.list(tenantId, {
      page: 0,
      per_page: 100,
      include_totals: false,
    });
    expect(
      logs.some(
        (l) =>
          l.type === LogTypes.FAILED_HOOK &&
          (l.details as { reason?: string } | undefined)?.reason ===
            "primary_not_found",
      ),
    ).toBe(true);
  });
});

describe("post-user-login: setLinkedTo with anchors", () => {
  async function seedUser(
    env: Bindings,
    overrides: Partial<User> & { user_id: string },
  ) {
    return env.data.users.create(tenantId, {
      email: "member@example.com",
      email_verified: true,
      provider: "email",
      connection: Strategy.EMAIL,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      ...overrides,
    });
  }

  async function setupLinking() {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    return { env, ctx, data, usersApi, externalConnections };
  }

  it("puts an existing unlinked user under a newer anchor (anchor wins regardless of age)", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const current = await seedUser(env, { user_id: "email|old-user" });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: current,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });

    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    await linking.api.user.setLinkedTo(ANCHOR);

    expect(linking.getLinkedPrimaryId()).toBe(ANCHOR);
    expect(
      (await env.data.users.get(tenantId, current.user_id))?.linked_to,
    ).toBe(ANCHOR);
    expect((await env.data.users.get(tenantId, ANCHOR))?.linked_to).toBeFalsy();
  });

  it("moves an existing cluster (primary + secondaries) under the anchor", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const primary = await seedUser(env, { user_id: "email|primary" });
    await seedUser(env, {
      user_id: "sms|secondary",
      email: undefined,
      phone_number: "+46700000000",
      provider: "sms",
      connection: Strategy.SMS,
      linked_to: primary.user_id,
    });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: primary,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });

    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    await linking.api.user.setLinkedTo(ANCHOR);

    expect(
      (await env.data.users.get(tenantId, "email|primary"))?.linked_to,
    ).toBe(ANCHOR);
    expect(
      (await env.data.users.get(tenantId, "sms|secondary"))?.linked_to,
    ).toBe(ANCHOR);
  });

  it("is a no-op when the logging-in primary already is the anchor", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    const anchor = await env.data.users.get(tenantId, ANCHOR);
    expect(anchor).toBeTruthy();

    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: anchor as User,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });
    await linking.api.user.setLinkedTo(ANCHOR);

    expect(linking.getLinkedPrimaryId()).toBe(ANCHOR);
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual([]);
  });

  it("refuses to re-anchor a user who is already under a different anchor", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    await usersApi.api.users.ensure({ connection: "parat", id: "111" });
    await usersApi.api.users.ensure({ connection: "parat", id: "222" });
    const firstAnchor = await env.data.users.get(tenantId, "parat|111");

    // Post-login runs on the primary: the user's cluster root is parat|111.
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: firstAnchor as User,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });
    await linking.api.user.setLinkedTo("parat|222");

    expect(linking.getLinkedPrimaryId()).toBeNull();
    expect(
      (await env.data.users.get(tenantId, "parat|111"))?.linked_to,
    ).toBeFalsy();
    expect(
      (await env.data.users.get(tenantId, "parat|222"))?.linked_to,
    ).toBeFalsy();
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual(["already_anchored"]);
  });

  it("refuses a second anchor within the same execution", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const current = await seedUser(env, { user_id: "email|member" });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: current,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });

    await usersApi.api.users.ensure({ connection: "parat", id: "111" });
    await usersApi.api.users.ensure({ connection: "parat", id: "222" });
    await linking.api.user.setLinkedTo("parat|111");
    await linking.api.user.setLinkedTo("parat|222");

    expect(linking.getLinkedPrimaryId()).toBe("parat|111");
    expect(
      (await env.data.users.get(tenantId, "email|member"))?.linked_to,
    ).toBe("parat|111");
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual(["already_anchored"]);
  });

  it("still rejects a user_id that was neither a candidate nor ensured", async () => {
    const { env, ctx, data, externalConnections } = await setupLinking();
    const member = await seedUser(env, { user_id: "email|member" });
    await env.data.users.create(tenantId, {
      user_id: ANCHOR,
      provider: "parat",
      connection: "parat",
      email_verified: false,
    });
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: member,
      candidates: [],
      ensuredUserIds: new Set(),
      externalConnections,
    });

    await linking.api.user.setLinkedTo(ANCHOR);

    expect(
      (await env.data.users.get(tenantId, "email|member"))?.linked_to,
    ).toBeFalsy();
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual([
      "not_a_link_candidate",
    ]);
  });
});

describe("post-user-login action (integration)", () => {
  it("returns the anchor as the user for this login", async () => {
    const server = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
    });
    const env = server.env;
    await createExternalConnection(env);

    const current = await env.data.users.create(tenantId, {
      user_id: "email|int-member",
      email: "int-member@example.com",
      email_verified: true,
      provider: "email",
      connection: Strategy.EMAIL,
    });

    const action = await env.data.actions.create(tenantId, {
      name: "parat-anchor-login",
      code: `
exports.onExecutePostLogin = async (event, api) => {
  api.users.ensure({ connection: "parat", id: "214700", profile: { name: "Ada" } });
  api.user.setLinkedTo("parat|214700");
};
`,
    });
    await env.data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });

    const loginSession = await env.data.loginSessions.create(tenantId, {
      csrf_token: "csrf",
      authParams: {
        client_id: "clientId",
        response_type: "code",
        redirect_uri: "http://localhost/cb",
        scope: "openid",
        audience: "https://example.com",
      },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });

    const client = {
      id: "clientId",
      name: "Test",
      client_id: "clientId",
      tenant: { id: tenantId },
      callbacks: ["http://localhost/cb"],
      allowed_logout_urls: [],
      web_origins: [],
      grant_types: ["authorization_code"],
      connections: [],
    } as unknown as EnrichedClient;

    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.post("/run", async (ctx) => {
      Object.assign(ctx.env, env);
      ctx.set("tenant_id", tenantId);
      ctx.set("ip", "1.2.3.4");
      ctx.set("useragent", "test");
      ctx.set("client_id", "clientId");
      const result = await postUserLoginHook(
        ctx,
        env.data,
        tenantId,
        current,
        loginSession,
        { client, authParams: loginSession.authParams },
      );
      await flushBackgroundPromises(ctx);
      const user = result as User;
      return ctx.json({ user_id: user.user_id, name: user.name ?? null });
    });

    const response = await app.request("/run", { method: "POST" }, env);
    expect(await response.json()).toEqual({ user_id: ANCHOR, name: "Ada" });
    expect(
      (await env.data.users.get(tenantId, "email|int-member"))?.linked_to,
    ).toBe(ANCHOR);
  });
});

describe("external connections are not login connections", () => {
  it("are filtered out of the enriched client", async () => {
    const { env } = await getTestServer();
    await createExternalConnection(env);

    const client = await getEnrichedClient(env, "clientId", tenantId);

    expect(client.connections.map((c) => c.name)).not.toContain("parat");
    expect(client.connections.length).toBeGreaterThan(0);
  });
});

describe("review follow-ups (PR #1805)", () => {
  it("keeps the external key exactly as given", async () => {
    const { env, usersApi } = await setupEnsure();
    await createExternalConnection(env);

    await usersApi.api.users.ensure({ connection: "parat", id: " 42" });

    expect(await env.data.users.get(tenantId, "parat| 42")).toBeTruthy();
    expect(await env.data.users.get(tenantId, "parat|42")).toBeNull();
  });

  it("refuses connection names used by injected or tenant login strategies", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    // A login connection backed by an injected strategy stores its users as
    // `partner-idp|…`.
    await env.data.connections.create(tenantId, {
      id: "partner-login",
      name: "partner-login",
      strategy: "partner-idp",
      options: {},
    });
    await createExternalConnection(env, "partner-idp");
    await createExternalConnection(env, "injected-idp");
    const usersApi = createActionUsersApi({
      ctx,
      data: env.data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections: createExternalConnectionLookup(env.data, tenantId, [
        "injected-idp",
      ]),
    });

    await usersApi.api.users.ensure({ connection: "partner-idp", id: "1" });
    await usersApi.api.users.ensure({ connection: "injected-idp", id: "1" });

    expect(await env.data.users.get(tenantId, "partner-idp|1")).toBeNull();
    expect(await env.data.users.get(tenantId, "injected-idp|1")).toBeNull();
    expect(reasonsOf(await hookLogs(env, ctx))).toEqual([
      "connection_not_allowed",
      "connection_not_allowed",
    ]);
  });

  it("finds the external connection beyond the first page of connections", async () => {
    const { env, usersApi } = await setupEnsure();
    for (let i = 0; i < 110; i++) {
      await env.data.connections.create(tenantId, {
        id: `filler-${i}`,
        name: `filler-${i}`,
        strategy: Strategy.OIDC,
        options: {},
      });
    }
    await createExternalConnection(env);

    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });

    expect(await env.data.users.get(tenantId, ANCHOR)).toBeTruthy();
  });

  it("does not carry email_verified over to a different address", async () => {
    const { env, usersApi } = await setupEnsure();
    await createExternalConnection(env);

    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { email: "old@example.com", email_verified: true },
    });
    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { email: "old@example.com", given_name: "Ada" },
    });
    expect((await env.data.users.get(tenantId, ANCHOR))?.email_verified).toBe(
      true,
    );

    await usersApi.api.users.ensure({
      connection: "parat",
      id: "214700",
      profile: { email: "new@example.com" },
    });
    const anchor = await env.data.users.get(tenantId, ANCHOR);
    expect(anchor?.email).toBe("new@example.com");
    expect(anchor?.email_verified).toBe(false);
  });

  it("moves the whole cluster when an earlier setLinkedTo already re-pointed the user", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const older = await env.data.users.create(tenantId, {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|older`,
      email: "member@example.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    const current = await env.data.users.create(tenantId, {
      user_id: "email|newer",
      email: "member@example.com",
      email_verified: true,
      provider: "email",
      connection: Strategy.EMAIL,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: current,
      candidates: [older],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });

    await linking.api.user.setLinkedTo(older.user_id);
    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    await linking.api.user.setLinkedTo(ANCHOR);

    expect(linking.getLinkedPrimaryId()).toBe(ANCHOR);
    expect((await env.data.users.get(tenantId, older.user_id))?.linked_to).toBe(
      ANCHOR,
    );
    expect(
      (await env.data.users.get(tenantId, current.user_id))?.linked_to,
    ).toBe(ANCHOR);
  });

  it("keeps the missing-target fallback unlinked even when built-in email linking would match", async () => {
    const { env, managementApp } = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
    });
    await env.data.users.create(tenantId, {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|existing`,
      email: "fallback@example.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
    });
    const action = await env.data.actions.create(tenantId, {
      name: "missing-target",
      code: `
exports.onExecutePreUserRegistration = async (event, api) => {
  api.user.setLinkedTo("parat|missing");
};
`,
    });
    await env.data.hooks.create(tenantId, {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const response = await client.users.$post(
      {
        json: {
          email: "fallback@example.com",
          email_verified: true,
          connection: Strategy.EMAIL,
        },
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as UserResponse;
    expect(created.user_id.startsWith("email|")).toBe(true);
    const stored = await env.data.users.get(tenantId, created.user_id);
    expect(stored?.linked_to).toBeFalsy();
  });

  it("returns the refreshed anchor when the signing-in primary is the anchor it ensures", async () => {
    const server = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
    });
    const env = server.env;
    await createExternalConnection(env);
    const anchor = await env.data.users.create(tenantId, {
      user_id: ANCHOR,
      provider: "parat",
      connection: "parat",
      email_verified: false,
      name: "Old name",
    });
    const action = await env.data.actions.create(tenantId, {
      name: "refresh-anchor",
      code: `
exports.onExecutePostLogin = async (event, api) => {
  api.users.ensure({ connection: "parat", id: "214700", profile: { name: "New name" } });
  api.user.setLinkedTo("parat|214700");
};
`,
    });
    await env.data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });
    const loginSession = await env.data.loginSessions.create(tenantId, {
      csrf_token: "csrf",
      authParams: {
        client_id: "clientId",
        response_type: "code",
        redirect_uri: "http://localhost/cb",
        scope: "openid",
      },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const client = {
      id: "clientId",
      name: "Test",
      client_id: "clientId",
      tenant: { id: tenantId },
      callbacks: ["http://localhost/cb"],
      allowed_logout_urls: [],
      web_origins: [],
      grant_types: ["authorization_code"],
      connections: [],
    } as unknown as EnrichedClient;

    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.post("/run", async (ctx) => {
      Object.assign(ctx.env, env);
      ctx.set("tenant_id", tenantId);
      ctx.set("ip", "1.2.3.4");
      ctx.set("useragent", "test");
      ctx.set("client_id", "clientId");
      const result = await postUserLoginHook(
        ctx,
        env.data,
        tenantId,
        anchor,
        loginSession,
        { client, authParams: loginSession.authParams },
      );
      await flushBackgroundPromises(ctx);
      const user = result as User;
      return ctx.json({ user_id: user.user_id, name: user.name ?? null });
    });

    const response = await app.request("/run", { method: "POST" }, env);
    expect(await response.json()).toEqual({
      user_id: ANCHOR,
      name: "New name",
    });
  });

  it("treats /authorize?connection=<external> like an unknown connection", async () => {
    const { oauthApp, env } = await getTestServer();
    await createExternalConnection(env);
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          scope: "openid",
          response_type: "code",
          connection: "parat",
        },
      },
      { headers: { origin: "https://example.com" } },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Connection Not Found");
  });
});

describe("review follow-ups, round 2 (PR #1805)", () => {
  it("records the cluster root when the ensured target is itself a secondary", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    const root = await env.data.users.create(tenantId, {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|root`,
      email: "root@example.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    // Newer than the anchor, so the age rule demotes the signing-in user.
    const current = await env.data.users.create(tenantId, {
      user_id: "email|newest",
      email: "newest@example.com",
      email_verified: true,
      provider: "email",
      connection: Strategy.EMAIL,
      created_at: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z",
    });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    await usersApi.api.users.ensure({ connection: "parat", id: "214700" });
    // An admin had put the anchor under another account.
    await env.data.users.update(tenantId, ANCHOR, { linked_to: root.user_id });

    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: current,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });
    await linking.api.user.setLinkedTo(ANCHOR);

    expect(linking.getLinkedPrimaryId()).toBe(root.user_id);
    expect(
      (await env.data.users.get(tenantId, current.user_id))?.linked_to,
    ).toBe(root.user_id);
  });
});

describe("review follow-ups, round 3 (PR #1805)", () => {
  it("classifies an ensured target by its cluster root, so an external root wins over age", async () => {
    const { env } = await getTestServer();
    const ctx = createMockCtx(env);
    const data = addDataHooks(ctx, env.data);
    await createExternalConnection(env);
    // Older than any anchor, so a plain age comparison would make it primary.
    const current = await env.data.users.create(tenantId, {
      user_id: "email|old-member",
      email: "old-member@example.com",
      email_verified: true,
      provider: "email",
      connection: Strategy.EMAIL,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    const externalConnections = createExternalConnectionLookup(data, tenantId);
    const usersApi = createActionUsersApi({
      ctx,
      data,
      tenantId,
      triggerId: "post-user-login",
      externalConnections,
    });
    await usersApi.api.users.ensure({ connection: "parat", id: "root" });
    await usersApi.api.users.ensure({ connection: "parat", id: "alias" });
    // An admin had merged the alias record under the root record.
    await env.data.users.update(tenantId, "parat|alias", {
      linked_to: "parat|root",
    });

    const linking = createPostLoginUserApi({
      ctx,
      data,
      tenantId,
      user: current,
      candidates: [],
      ensuredUserIds: usersApi.ensuredUserIds,
      externalConnections,
    });
    await linking.api.user.setLinkedTo("parat|alias");

    expect(linking.getLinkedPrimaryId()).toBe("parat|root");
    expect(
      (await env.data.users.get(tenantId, current.user_id))?.linked_to,
    ).toBe("parat|root");
    expect((await env.data.users.get(tenantId, "parat|alias"))?.linked_to).toBe(
      "parat|root",
    );
    expect(
      (await env.data.users.get(tenantId, "parat|root"))?.linked_to,
    ).toBeFalsy();
  });
});
