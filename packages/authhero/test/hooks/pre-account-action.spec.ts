import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionExecutionInsert } from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { getTestServer } from "../helpers/test-server";
import type {
  OnExecutePreAccountActionAPI,
  PreAccountActionEvent,
} from "../../src/types/Hooks";

const TENANT = "tenantId";
const USER_ID = "email|userId";
const COOKIE = "tenantId-auth-token=account-session";

async function setup(
  options: Parameters<typeof getTestServer>[0] & { withSession?: boolean } = {},
) {
  const executions: ActionExecutionInsert[] = [];
  const { withSession = true, ...serverOptions } = options;
  const server = await getTestServer({
    codeExecutor: new LocalCodeExecutor(),
    wrapDataAdapter: (data) => ({
      ...data,
      actionExecutions: {
        ...data.actionExecutions,
        create: async (tenant, execution) => {
          executions.push(execution);
          return data.actionExecutions.create(tenant, execution);
        },
      },
    }),
    ...serverOptions,
  });
  const { env } = server;
  const loginSession = await env.data.loginSessions.create(TENANT, {
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com",
    },
  });
  if (withSession) {
    await env.data.sessions.create(TENANT, {
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
    await env.data.loginSessions.update(TENANT, loginSession.id, {
      session_id: "account-session",
    });
  }

  async function bind(body: string, priority = 0) {
    const action = await env.data.actions.create(TENANT, {
      name: `pre-account-action-${priority}`,
      supported_triggers: [{ id: "pre-account-action" }],
      code: `exports.onExecutePreAccountAction = async (event, api) => { ${body} };`,
    });
    await env.data.hooks.create(TENANT, {
      code_id: action.id,
      trigger_id: "pre-account-action",
      enabled: true,
      priority,
    });
  }

  const state = loginSession.id;
  const get = (path: string) =>
    server.u2App.request(
      `${path}${path.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`,
      { headers: { "tenant-id": TENANT, cookie: COOKIE } },
      env,
    );
  const postScreen = (screenId: string, data: Record<string, string>) =>
    server.u2App.request(
      `/screen/${screenId}?state=${encodeURIComponent(state)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": TENANT,
          cookie: COOKIE,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ data }),
      },
      env,
    );

  return { ...server, state, bind, get, postScreen, executions };
}

afterEach(() => vi.useRealTimers());

describe("pre-account-action trigger", () => {
  it("leaves the account screens unchanged when nothing is bound", async () => {
    const { get, executions } = await setup();
    const response = await get("/account/profile");
    expect(response.status).toBe(200);
    expect(executions).toHaveLength(0);
  });

  it("redirects to the URL an Action sends the user to, without leaking state", async () => {
    const { get, bind, executions } = await setup();
    await bind(`
      if (event.operation === "update-profile" && event.connection.name === "email") {
        api.redirect.sendUserTo("https://idp.example.com/profile", {
          query: { op: event.operation, user: event.user.email },
        });
      }
    `);

    const response = await get("/account/profile");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://idp.example.com/profile",
    );
    expect(location.searchParams.get("op")).toBe("update-profile");
    expect(location.searchParams.get("user")).toBe("foo@example.com");
    expect(location.searchParams.has("state")).toBe(false);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      trigger_id: "pre-account-action",
      status: "final",
    });
  });

  it("lets the operation continue when the Action does nothing for it", async () => {
    const { get, bind } = await setup();
    await bind(`
      if (event.operation === "delete-account") {
        api.redirect.sendUserTo("https://idp.example.com/delete");
      }
    `);
    expect((await get("/account/profile")).status).toBe(200);
    expect((await get("/account/delete")).status).toBe(302);
  });

  it("shows the deny reason on the error page", async () => {
    const { get, bind, executions } = await setup();
    await bind(`api.access.deny("Your profile is managed by Acme");`);

    const response = await get("/account/delete");

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Your profile is managed by Acme");
    expect(executions[0]).toMatchObject({ status: "canceled" });
  });

  it("fails closed when an Action throws", async () => {
    const { get, bind, executions } = await setup();
    await bind(`throw new Error("boom");`);

    const response = await get("/account/profile");

    expect(response.status).toBe(403);
    // The apostrophe in the default text is HTML-escaped on the page.
    expect(await response.text()).toContain("available for your account.");
    expect(executions[0]).toMatchObject({ status: "partial" });
  });

  it("fails closed when an Action redirects to a non-http URL", async () => {
    const { get, bind } = await setup();
    await bind(`api.redirect.sendUserTo("javascript:alert(1)");`);
    expect((await get("/account/profile")).status).toBe(403);
  });

  it("stops at the first Action that decides, in priority order", async () => {
    const { get, bind, executions } = await setup();
    await bind(`api.redirect.sendUserTo("https://second.example.com");`, 1);
    await bind(`api.redirect.sendUserTo("https://first.example.com");`, 10);

    const response = await get("/account/profile");

    expect(response.headers.get("location")).toBe("https://first.example.com/");
    expect(executions[0]!.results).toHaveLength(1);
  });

  it("passes operation details to the config hook", async () => {
    const events: Array<Omit<PreAccountActionEvent, "ctx">> = [];
    const { get } = await setup({
      hooks: {
        onExecutePreAccountAction: async ({ ctx: _ctx, ...event }, api) => {
          events.push(event);
          api.redirect.sendUserTo("/elsewhere");
        },
      },
    });

    const response = await get("/account/security/totp-enrollment");

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/elsewhere",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "enroll-mfa",
      details: { factor: "totp" },
      tenant: { id: TENANT },
      user: { user_id: USER_ID },
      connection: { name: "email" },
      client: { client_id: "clientId" },
    });
  });

  it("gates button operations on POST and hands the redirect to the widget", async () => {
    const { postScreen, bind, env } = await setup();
    await bind(`
      if (event.operation === "unlink-identity") {
        api.redirect.sendUserTo("https://idp.example.com/identities", {
          query: { provider: event.details.provider },
        });
      }
    `);

    const response = await postScreen("account-linked", {
      action: "unlink_account:google-oauth2:123",
    });

    // The JSON screen API reports redirects in the body for the widget.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirect: "https://idp.example.com/identities?provider=google-oauth2",
    });
    expect(await env.data.users.get(TENANT, USER_ID)).not.toBeNull();
  });

  it("runs for password reset without a user when no identifier is known", async () => {
    const events: Array<Omit<PreAccountActionEvent, "ctx">> = [];
    const { get } = await setup({
      withSession: false,
      hooks: {
        onExecutePreAccountAction: async ({ ctx: _ctx, ...event }, api) => {
          events.push(event);
          if (!event.user)
            api.redirect.sendUserTo("https://idp.example.com/reset");
        },
      },
    });

    const response = await get("/reset-password/request");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.com/reset",
    );
    expect(events[0]).toMatchObject({ operation: "reset-password" });
    expect(events[0]!.user).toBeUndefined();
  });

  it("gates /account?screen_hint=change-email before entering the flow", async () => {
    const { oauthApp, env, bind } = await setup();
    await bind(`
      if (event.operation === "change-email") {
        api.redirect.sendUserTo("https://idp.example.com/email");
      }
    `);

    const response = await oauthApp.request(
      "/account?client_id=clientId&screen_hint=change-email",
      { headers: { cookie: COOKIE } },
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.com/email",
    );
  });

  it("gates the classic change-email page", async () => {
    const { universalApp, env, state, bind } = await setup();
    await bind(`api.access.deny("Change your email at Acme");`);

    const response = await universalApp.request(
      `/account/change-email?state=${encodeURIComponent(state)}`,
      { headers: { cookie: COOKIE } },
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Change your email at Acme");
  });

  it("re-checks reset-password on submit, resolving the user from the submitted email", async () => {
    const events: Array<Omit<PreAccountActionEvent, "ctx">> = [];
    const { postScreen } = await setup({
      withSession: false,
      hooks: {
        onExecutePreAccountAction: async ({ ctx: _ctx, ...event }, api) => {
          events.push(event);
          api.access.deny("Reset your password at Acme");
        },
      },
    });

    const response = await postScreen("forgot-password", {
      email: "Foo@Example.com",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Reset your password at Acme",
    });
    expect(events[0]).toMatchObject({
      operation: "reset-password",
      user: { user_id: USER_ID },
    });
  });

  it("re-checks the classic change-email form on submit", async () => {
    const { universalApp, env, state, bind, getSentEmails } = await setup({
      mockEmail: true,
    });
    await bind(`api.access.deny("Change your email at Acme");`);

    const response = await universalApp.request(
      `/account/change-email?state=${encodeURIComponent(state)}`,
      {
        method: "POST",
        headers: {
          cookie: COOKIE,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "email=new%40example.com",
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(getSentEmails()).toHaveLength(0);
  });

  it("decides passkey removal from the security page as remove-passkey", async () => {
    const operations: string[] = [];
    const { postScreen, env } = await setup({
      hooks: {
        onExecutePreAccountAction: async (event, api) => {
          operations.push(event.operation);
          if (event.operation === "remove-passkey") api.access.deny();
        },
      },
    });
    const passkey = await env.data.authenticationMethods.create(TENANT, {
      user_id: USER_ID,
      type: "passkey",
      credential_id: "cred-1",
      public_key: "public-key",
      confirmed: true,
    });

    const response = await postScreen("account-security", {
      action: "remove_enrollment",
      enrollment_id: passkey.id,
    });

    expect(response.status).toBe(403);
    expect(operations).toEqual(["remove-passkey"]);
    expect(
      await env.data.authenticationMethods.get(TENANT, passkey.id),
    ).not.toBeNull();
  });

  it("gates passkey completion, not only its start", async () => {
    const operations: string[] = [];
    const { postScreen } = await setup({
      hooks: {
        onExecutePreAccountAction: async (event, api) => {
          operations.push(event.operation);
          api.redirect.sendUserTo("https://idp.example.com/passkeys");
        },
      },
    });

    const response = await postScreen("account-passkeys", {
      action: "complete_add_passkey",
      "credential-field": "{}",
    });

    expect(await response.json()).toEqual({
      redirect: "https://idp.example.com/passkeys",
    });
    expect(operations).toEqual(["enroll-passkey"]);
  });

  it("denies when the config callback never settles, and ignores its late calls", async () => {
    let lateApi: OnExecutePreAccountActionAPI | undefined;
    const { get } = await setup({
      hooks: {
        onExecutePreAccountAction: (_event, api) => {
          lateApi = api;
          return new Promise<void>(() => {});
        },
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = get("/account/profile");
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;

    expect(response.status).toBe(403);
    // A call after the deadline must not throw or change the result.
    lateApi?.redirect.sendUserTo("https://late.example.com");
  });
});
