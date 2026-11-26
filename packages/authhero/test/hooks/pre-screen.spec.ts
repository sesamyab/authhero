import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPreScreenScreen,
  LogTypes,
  PRE_SCREEN_SCREENS,
  type ActionExecutionInsert,
} from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import type {
  OnExecutePreScreenAPI,
  PreScreenEvent,
} from "../../src/types/Hooks";
import {
  getScreenDefinition,
  listScreenIds,
} from "../../src/routes/universal-login/screens/registry";
import {
  getPreScreenName,
  listPreScreenScreenIds,
} from "../../src/routes/universal-login/pre-screen-gates";

const TENANT = "tenantId";
const USER_ID = "email|userId";
const COOKIE = "tenantId-auth-token=account-session";

type RecordedEvent = Omit<PreScreenEvent, "ctx">;

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
    authorization_url:
      "https://example.com/authorize?client_id=clientId&screen_hint=login",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      scope: "openid email",
      state: "app-state",
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

  async function bind(
    body: string,
    options: { priority?: number; metadata?: Record<string, unknown> } = {},
  ) {
    const priority = options.priority ?? 0;
    const action = await env.data.actions.create(TENANT, {
      name: `pre-screen-${priority}`,
      supported_triggers: [{ id: "pre-screen" }],
      code: `exports.onExecutePreScreen = async (event, api) => { ${body} };`,
    });
    return env.data.hooks.create(TENANT, {
      code_id: action.id,
      trigger_id: "pre-screen",
      enabled: true,
      priority,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
  }

  const state = loginSession.id;
  const withState = (path: string) =>
    `${path}${path.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`;
  /** u2 HTML route */
  const get = (path: string) =>
    server.u2App.request(
      withState(path),
      { headers: { "tenant-id": TENANT, cookie: COOKIE } },
      env,
    );
  /** u2 HTML form POST */
  const postForm = (path: string, data: Record<string, string>) =>
    server.u2App.request(
      withState(path),
      {
        method: "POST",
        headers: {
          "tenant-id": TENANT,
          cookie: COOKIE,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(data).toString(),
      },
      env,
    );
  /** u2 JSON screen API */
  const getScreen = (screenId: string) =>
    server.u2App.request(
      withState(`/screen/${screenId}`),
      {
        headers: {
          "tenant-id": TENANT,
          cookie: COOKIE,
          accept: "application/json",
        },
      },
      env,
    );
  const postScreen = (screenId: string, data: Record<string, string>) =>
    server.u2App.request(
      withState(`/screen/${screenId}`),
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
  /** classic /u route */
  const classic = (
    path: string,
    init: { method?: string; form?: Record<string, string> } = {},
  ) =>
    server.universalApp.request(
      withState(path),
      {
        method: init.method ?? "GET",
        headers: {
          cookie: COOKIE,
          ...(init.form
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(init.form
          ? { body: new URLSearchParams(init.form).toString() }
          : {}),
      },
      env,
    );

  return {
    ...server,
    state,
    bind,
    get,
    postForm,
    getScreen,
    postScreen,
    classic,
    executions,
  };
}

function recorder(
  decide?: (event: RecordedEvent, api: OnExecutePreScreenAPI) => void,
) {
  const events: RecordedEvent[] = [];
  return {
    events,
    hooks: {
      onExecutePreScreen: async (
        { ctx: _ctx, ...event }: PreScreenEvent,
        api: OnExecutePreScreenAPI,
      ) => {
        events.push(event);
        decide?.(event, api);
      },
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("pre-screen screen catalogue", () => {
  it("gates every registry screen with a catalogued screen name", () => {
    for (const screenId of listScreenIds()) {
      const name = getPreScreenName(screenId);
      expect(name, screenId).toBeDefined();
      expect(getPreScreenScreen(name!), screenId).toBeDefined();
    }
  });

  it("names every catalogued screen exactly once", () => {
    const names = PRE_SCREEN_SCREENS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const used = new Set(listPreScreenScreenIds().map(getPreScreenName));
    for (const name of names) expect(used.has(name), name).toBe(true);
  });

  it("uses Auth0's names for the login screens", () => {
    expect(getPreScreenName("identifier")).toBe("login-id");
    expect(getPreScreenName("enter-password")).toBe("login-password");
    expect(getPreScreenName("email-otp-challenge")).toBe(
      "login-passwordless-email-code",
    );
    expect(getPreScreenName("forgot-password")).toBe("reset-password-request");
    expect(getPreScreenName("mfa-totp-challenge")).toBe("mfa-otp-challenge");
  });
});

describe("pre-screen trigger", () => {
  it("fires on render of every u2 screen, before the screen runs", async () => {
    const { events, hooks } = recorder((event, api) =>
      api.access.deny(`${event.transaction.phase}:${event.screen.name}`),
    );
    const { getScreen } = await setup({ hooks });

    for (const screenId of listScreenIds()) {
      const response = await getScreen(screenId);
      expect(response.status, screenId).toBe(403);
      expect(await response.json(), screenId).toEqual({
        error: `render:${getPreScreenName(screenId)}`,
      });
    }
    expect(events).toHaveLength(listScreenIds().length);
  });

  it("fires on submit of every u2 screen that accepts a POST", async () => {
    const { hooks } = recorder((event, api) => {
      if (event.transaction.phase === "submit") {
        api.access.deny(`submit:${event.screen.name}`);
      }
    });
    const { postScreen } = await setup({ hooks });

    const postable = listScreenIds().filter(
      (id) => getScreenDefinition(id)?.handler.post,
    );
    expect(postable.length).toBeGreaterThan(20);
    for (const screenId of postable) {
      const response = await postScreen(screenId, {});
      expect(response.status, screenId).toBe(403);
      expect(await response.json(), screenId).toEqual({
        error: `submit:${getPreScreenName(screenId)}`,
      });
    }
  });

  it("runs nothing when no action is bound", async () => {
    const { get, executions } = await setup();
    expect((await get("/login/identifier")).status).toBe(200);
    expect((await get("/account/profile")).status).toBe(200);
    expect(executions).toHaveLength(0);
  });

  it("runs a binding only for the screens it selected", async () => {
    const { get, bind, executions } = await setup();
    await bind(`api.access.deny("Profile is managed elsewhere");`, {
      metadata: { screens: ["account-profile"] },
    });

    expect((await get("/login/identifier")).status).toBe(200);
    expect((await get("/account")).status).toBe(200);
    expect(executions).toHaveLength(0);

    const response = await get("/account/profile");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Profile is managed elsewhere");
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      trigger_id: "pre-screen",
      status: "canceled",
    });
  });

  it("logs a denial with the failed-hook log type", async () => {
    const { get, bind, env } = await setup();
    await bind(`api.access.deny("No");`);

    expect((await get("/account/delete")).status).toBe(403);
    const { logs } = await env.data.logs.list(TENANT);
    expect(
      logs.find(
        (log) =>
          log.type === LogTypes.FAILED_HOOK &&
          log.description === "pre-screen denied render of account-delete",
      ),
    ).toBeDefined();
  });

  it("cannot be skipped by a direct POST: submit denies with no side effect", async () => {
    const { get, postScreen, bind, env } = await setup();
    await bind(`
      if (event.transaction.phase === "submit") {
        api.access.deny("Profile changes are disabled");
      }
    `);

    expect((await get("/account/profile")).status).toBe(200);
    const response = await postScreen("account-profile", {
      given_name: "Changed",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Profile changes are disabled",
    });
    const user = await env.data.users.get(TENANT, USER_ID);
    expect(user?.given_name).not.toBe("Changed");
  });

  it("passes the operation of a button on a shared screen", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.operation === "unlink-identity") {
        api.redirect.sendUserTo("https://idp.example.com/identities", {
          query: { provider: event.details?.provider ?? "" },
        });
      }
    });
    const { postScreen, env } = await setup({ hooks });

    const response = await postScreen("account-linked", {
      action: "unlink_account:google-oauth2:123",
    });

    // The JSON screen API reports redirects in the body for the widget.
    expect(await response.json()).toEqual({
      redirect: "https://idp.example.com/identities?provider=google-oauth2",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      screen: { name: "account-linked" },
      prompt: { name: "account" },
      transaction: { phase: "submit" },
      operation: "unlink-identity",
      details: { provider: "google-oauth2", user_id: "123" },
      user: { user_id: USER_ID },
    });
    expect(await env.data.users.get(TENANT, USER_ID)).not.toBeNull();
  });

  it("decides passkey removal from the security page as remove-passkey", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.operation === "remove-passkey") api.access.deny();
    });
    const { postScreen, env } = await setup({ hooks });
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
    expect(events.map((e) => e.operation)).toEqual(["remove-passkey"]);
    expect(
      await env.data.authenticationMethods.get(TENANT, passkey.id),
    ).not.toBeNull();
  });

  it("gates passkey completion and leaves renaming without an operation", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.operation === "enroll-passkey") {
        api.redirect.sendUserTo("https://idp.example.com/passkeys");
      }
    });
    const { postScreen } = await setup({ hooks });

    const response = await postScreen("account-passkeys", {
      action: "complete_add_passkey",
      "credential-field": "{}",
    });
    expect(await response.json()).toEqual({
      redirect: "https://idp.example.com/passkeys",
    });

    await postScreen("account-passkeys", {
      action: "rename_passkey",
      passkey_id: "x",
    });
    expect(
      events
        .filter((e) => e.transaction.phase === "submit")
        .map((e) => e.operation),
    ).toEqual(["enroll-passkey", undefined]);
  });

  it("fails open on render and closed on submit when an action throws", async () => {
    const { get, postScreen, bind, executions, env } = await setup();
    await bind(`throw new Error("boom");`);

    const page = await get("/account/profile");
    expect(page.status).toBe(200);
    expect(executions[0]).toMatchObject({ status: "partial" });
    const { logs } = await env.data.logs.list(TENANT);
    expect(
      logs.some(
        (log) =>
          log.type === LogTypes.FAILED_HOOK &&
          log.description?.includes("screen shown"),
      ),
    ).toBe(true);

    const submit = await postScreen("account-profile", { given_name: "X" });
    expect(submit.status).toBe(403);
    // The apostrophe in the default text is escaped in HTML, not in JSON.
    expect(await submit.json()).toEqual({
      error: "This isn't available for your account.",
    });
  });

  it("fails closed on render when the binding opts in", async () => {
    const { get, bind } = await setup();
    await bind(`throw new Error("boom");`, { metadata: { fail_closed: true } });

    const response = await get("/account/profile");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("available for your account.");
  });

  it("shows the screen when a render redirect isn't http(s), and denies the submit", async () => {
    const { get, postScreen, bind } = await setup();
    await bind(`api.redirect.sendUserTo("javascript:alert(1)");`);
    expect((await get("/account/profile")).status).toBe(200);
    expect((await postScreen("account-profile", {})).status).toBe(403);
  });

  it("stops at the first action that decides, in priority order", async () => {
    const { get, bind, executions } = await setup();
    await bind(`api.redirect.sendUserTo("https://second.example.com");`, {
      priority: 1,
    });
    await bind(`api.redirect.sendUserTo("https://first.example.com");`, {
      priority: 10,
    });

    const response = await get("/account/profile");

    expect(response.headers.get("location")).toBe("https://first.example.com/");
    expect(executions[0]!.results).toHaveLength(1);
  });

  it("redirects before the login form is shown, and the transaction stays usable", async () => {
    const { get, bind, env, state, executions } = await setup({
      withSession: false,
    });
    const hook = await bind(`
      if (event.screen.name === "login-id" && event.transaction.phase === "render") {
        api.redirect.sendUserTo("https://idp.example.com/login", {
          query: { client: event.client.client_id },
        });
      }
    `);

    const response = await get(
      "/login/identifier?redirect_uri=https%3A%2F%2Fevil.example.com",
    );

    // Exactly what the action returned: no request parameters, no state.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.com/login?client=clientId",
    );
    expect(executions).toHaveLength(1);

    // Coming back later on the same transaction shows the screen as usual.
    await env.data.hooks.update(TENANT, hook.hook_id, { enabled: false });
    expect((await get("/login/identifier")).status).toBe(200);
    expect(await env.data.loginSessions.get(TENANT, state)).toMatchObject({
      id: state,
    });
  });

  it("redirects on submit of the identifier step with the entered user", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (
        event.screen.name === "login-id" &&
        event.transaction.phase === "submit" &&
        event.user?.email === "foo@example.com"
      ) {
        api.redirect.sendUserTo("https://idp.example.com/sso", {
          query: { login_hint: event.user.email },
        });
      }
    });
    const { postForm, env, state } = await setup({ withSession: false, hooks });

    const response = await postForm("/login/identifier", {
      username: "Foo@Example.com",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.com/sso?login_hint=foo%40example.com",
    );
    expect(events.at(-1)).toMatchObject({
      prompt: { name: "login-id" },
      user: { user_id: USER_ID },
      transaction: {
        phase: "submit",
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        requested_scopes: ["openid", "email"],
        state: "app-state",
        screen_hint: "login",
      },
      tenant: { id: TENANT },
      client: { client_id: "clientId" },
    });
    // The submission never reached the screen, so the transaction is as it was.
    const loginSession = await env.data.loginSessions.get(TENANT, state);
    expect(loginSession?.authParams.username).toBeUndefined();
  });

  it("fires render for a screen a POST answers with directly", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.transaction.phase === "render") {
        api.access.deny("Use the app to sign in");
      }
    });
    const { postForm } = await setup({ withSession: false, hooks });

    // The test tenant's email connection signs in with a magic link, so the
    // identifier POST answers with the link-sent screen without a GET.
    const response = await postForm("/login/identifier", {
      username: "foo@example.com",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Use the app to sign in");
    expect(
      events.map((e) => `${e.transaction.phase}:${e.screen.name}`),
    ).toEqual(["submit:login-id", "render:magic-link-sent"]);
  });

  it("fires render for the same screen a POST shows again", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.transaction.phase === "render") api.access.deny("Not here");
    });
    const { postScreen } = await setup({ hooks });

    // Renaming answers with the passkeys screen and a success message.
    const response = await postScreen("account-passkeys", {
      action: "rename_passkey",
      passkey_id: "x",
    });

    expect(response.status).toBe(403);
    expect(
      events.map((e) => `${e.transaction.phase}:${e.screen.name}`),
    ).toEqual(["submit:account-passkeys", "render:account-passkeys"]);
  });

  it("doesn't let a submitted identifier choose the user on MFA screens", async () => {
    const { events, hooks } = recorder();
    const { postScreen, env, state } = await setup({
      withSession: false,
      hooks,
    });
    await env.data.users.create(TENANT, {
      user_id: "email|other",
      email: "other@example.com",
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
    });
    await env.data.loginSessions.update(TENANT, state, { user_id: USER_ID });

    await postScreen("mfa-totp-challenge", {
      code: "123456",
      email: "other@example.com",
      username: "other@example.com",
    });

    expect(events[0]).toMatchObject({
      screen: { name: "mfa-otp-challenge" },
      transaction: { phase: "submit" },
      user: { user_id: USER_ID },
    });
  });

  it("shows the screen when storing the execution record fails", async () => {
    const { get, bind } = await setup({
      wrapDataAdapter: (data) => ({
        ...data,
        actionExecutions: {
          ...data.actionExecutions,
          create: async () => {
            throw new Error("storage down");
          },
        },
      }),
    });
    await bind(`throw new Error("boom");`);

    expect((await get("/account/profile")).status).toBe(200);
  });

  it("knows the user on password reset from the submitted email", async () => {
    const { events, hooks } = recorder((_event, api) =>
      api.access.deny("Reset your password at Acme"),
    );
    const { postScreen } = await setup({ withSession: false, hooks });

    const response = await postScreen("forgot-password", {
      email: "Foo@Example.com",
    });

    expect(response.status).toBe(403);
    expect(events[0]).toMatchObject({
      screen: { name: "reset-password-request" },
      operation: "reset-password",
      user: { user_id: USER_ID },
    });
  });

  it("denies a submit when the config callback never settles, and ignores late calls", async () => {
    let lateApi: OnExecutePreScreenAPI | undefined;
    const { get, postScreen } = await setup({
      hooks: {
        onExecutePreScreen: (_event, api) => {
          lateApi = api;
          return new Promise<void>(() => {});
        },
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const render = get("/account/profile");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await render).status).toBe(200);

    const submit = postScreen("account-profile", {});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await submit).status).toBe(403);
    // A call after the deadline must not throw or change the result.
    lateApi?.redirect.sendUserTo("https://late.example.com");
  });

  it("gates /account?screen_hint=change-email through the change-email screen", async () => {
    const { oauthApp, u2App, env, bind } = await setup();
    await bind(`api.redirect.sendUserTo("https://idp.example.com/email");`, {
      metadata: { screens: ["account-change-email"] },
    });

    const response = await oauthApp.request(
      "/account?client_id=clientId&screen_hint=change-email",
      { headers: { cookie: COOKIE } },
      env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/u2/account/change-email");

    const screen = await u2App.request(
      `/account/change-email${location.search}`,
      { headers: { "tenant-id": TENANT, cookie: COOKIE } },
      env,
    );
    expect(screen.status).toBe(302);
    expect(screen.headers.get("location")).toBe(
      "https://idp.example.com/email",
    );
  });
});

describe("pre-screen on classic /u pages", () => {
  it("redirects the classic identifier page before it renders", async () => {
    const { classic, bind } = await setup({ withSession: false });
    await bind(`api.redirect.sendUserTo("https://idp.example.com/login");`, {
      metadata: { screens: ["login-id"] },
    });

    const response = await classic("/login/identifier");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.com/login",
    );
  });

  it("knows the user submitted on the classic identifier page", async () => {
    const { events, hooks } = recorder((event, api) => {
      if (event.transaction.phase === "submit") api.access.deny("Not here");
    });
    const { classic } = await setup({ withSession: false, hooks });

    const response = await classic("/login/identifier", {
      method: "POST",
      form: { username: "foo@example.com" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Not here");
    expect(events.at(-1)).toMatchObject({
      screen: { name: "login-id" },
      user: { user_id: USER_ID },
    });
  });

  it("denies the classic change-email form on submit without sending a code", async () => {
    const { classic, bind, getSentEmails } = await setup({ mockEmail: true });
    await bind(`
      if (event.transaction.phase === "submit") {
        api.access.deny("Change your email at Acme");
      }
    `);

    expect((await classic("/account/change-email")).status).toBe(200);
    const response = await classic("/account/change-email", {
      method: "POST",
      form: { email: "new@example.com" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Change your email at Acme");
    expect(getSentEmails()).toHaveLength(0);
  });

  it("gates the classic unlink button with its operation", async () => {
    const { events, hooks } = recorder((_event, api) => api.access.deny());
    const { classic } = await setup({ hooks });

    const response = await classic("/account", {
      method: "POST",
      form: {
        action: "unlink_account",
        provider: "google-oauth2",
        user_id: "123",
        csrf_token: "csrf",
      },
    });

    expect(response.status).toBe(403);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      screen: { name: "account" },
      operation: "unlink-identity",
      details: { provider: "google-oauth2", user_id: "123" },
    });
  });
});

describe("pre-screen in the management API", () => {
  async function management() {
    const server = await setup();
    const token = await getAdminToken();
    const request = (path: string, method: string, body: unknown) =>
      server.managementApp.request(
        path,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": TENANT,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        server.env,
      );
    return { ...server, request };
  }

  it("refuses the removed pre-account-action trigger with an Auth0-style 400", async () => {
    const { request, env } = await management();
    const action = await env.data.actions.create(TENANT, {
      name: "old",
      code: "exports.onExecutePreAccountAction = async () => {};",
    });

    const hook = await request("/hooks", "POST", {
      code_id: action.id,
      trigger_id: "pre-account-action",
    });
    expect(hook.status).toBe(400);
    expect(await hook.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
    });

    const bindings = await request(
      "/actions/triggers/pre-account-action/bindings",
      "PATCH",
      { bindings: [{ ref: { type: "action_id", value: action.id } }] },
    );
    expect(bindings.status).toBe(400);
    expect(await bindings.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: "Trigger pre-account-action does not support action bindings",
    });
  });

  it("rejects unknown screen names on a pre-screen hook", async () => {
    const { request, env } = await management();
    const action = await env.data.actions.create(TENANT, {
      name: "screens",
      code: "exports.onExecutePreScreen = async () => {};",
    });

    const response = await request("/hooks", "POST", {
      code_id: action.id,
      trigger_id: "pre-screen",
      metadata: { screens: ["login-id", "logn-password"] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: "Unknown screens in metadata.screens: logn-password",
    });
  });

  it("rejects non-string screen entries instead of running on every screen", async () => {
    const { request, env } = await management();
    const action = await env.data.actions.create(TENANT, {
      name: "screens",
      code: "exports.onExecutePreScreen = async () => {};",
    });

    const response = await request("/hooks", "POST", {
      code_id: action.id,
      trigger_id: "pre-screen",
      metadata: { screens: [["account-profile"]] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Unknown screens in metadata.screens: ["account-profile"]',
    });
  });

  it("checks the stored screens when a PATCH moves a hook onto pre-screen", async () => {
    const { request, env } = await management();
    const action = await env.data.actions.create(TENANT, {
      name: "move",
      code: "exports.onExecutePreScreen = async () => {};",
    });
    const hook = await env.data.hooks.create(TENANT, {
      code_id: action.id,
      trigger_id: "post-user-login",
      enabled: true,
      metadata: { screens: ["logn-id"] },
    });

    const response = await request(`/hooks/${hook.hook_id}`, "PATCH", {
      trigger_id: "pre-screen",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: "Unknown screens in metadata.screens: logn-id",
    });
  });

  it("keeps a binding's screen filter when the trigger's bindings are replaced", async () => {
    const { request, bind, env } = await management();
    const hook = await bind("", {
      metadata: { screens: ["signup"], fail_closed: true },
    });

    const response = await request(
      "/actions/triggers/pre-screen/bindings",
      "PATCH",
      { bindings: [{ ref: { type: "action_id", value: hook.code_id } }] },
    );
    expect(response.status).toBe(200);

    const { hooks } = await env.data.hooks.list(TENANT);
    const rebound = hooks.filter((h) => h.trigger_id === "pre-screen");
    expect(rebound).toHaveLength(1);
    expect(rebound[0]!.metadata).toEqual({
      screens: ["signup"],
      fail_closed: true,
    });
  });

  it("ignores a stored hook still bound to pre-account-action", async () => {
    const { get, env, executions } = await setup();
    const action = await env.data.actions.create(TENANT, {
      name: "old",
      code: `exports.onExecutePreAccountAction = async (event, api) => { api.access.deny(); };`,
    });
    // Stored before the trigger was removed; the insert type no longer allows it.
    const stored = JSON.parse(
      JSON.stringify({
        code_id: action.id,
        trigger_id: "pre-account-action",
        enabled: true,
      }),
    );
    await env.data.hooks.create(TENANT, stored);

    expect((await get("/account/profile")).status).toBe(200);
    expect(executions).toHaveLength(0);
  });
});
