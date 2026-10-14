import { describe, expect, it } from "vitest";
import type {
  ActionExecutionInsert,
  CodeExecutor,
} from "@authhero/adapter-interfaces";
import type { HookEvent } from "../../../src/types/Hooks";
import { getTestServer } from "../../helpers/test-server";
import {
  applyPartialErrors,
  getSignupPrefill,
  prefillPromptPartial,
} from "../../../src/routes/universal-login/screens/signup";
import { withHandlerError } from "../../../src/routes/universal-login/screens/handler-error";
import { LocalCodeExecutor } from "../../../src/hooks/code-executor/local";

type ScreenMessage = { text: string; type: string };
type ScreenComponent = {
  id: string;
  config?: Record<string, unknown>;
};
type ScreenBody = {
  screen: {
    messages?: ScreenMessage[];
    components: ScreenComponent[];
    partials?: Record<string, string>;
  };
};

async function seedSignupSession(
  env: Awaited<ReturnType<typeof getTestServer>>["env"],
) {
  return env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
    },
  });
}

describe("u2 signup pre-user-registration request body", () => {
  it("loads signup prompt partials into the shared SSR/JSON screen definition", async () => {
    const { u2App, env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start":
          '<div class="ulp-field"><input name="ulp-first-name" required></div>',
      },
      "signup-id": {
        "form-content-end": "must not render on the signup screen",
      },
    });
    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(loginSession.id)}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.partials).toEqual({
      "form-content-start":
        '<div class="ulp-field"><input name="ulp-first-name" required></div>',
    });
  });

  it("renders signup without partials when the adapter is not configured", async () => {
    const { u2App, env } = await getTestServer({
      wrapDataAdapter: (data) => ({ ...data, promptPartials: undefined }),
    });
    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(loginSession.id)}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.partials).toBeUndefined();
  });

  it("passes only ulp-* fields to config and code hooks", async () => {
    const configEvents: HookEvent[] = [];
    const codeEvents: Record<string, unknown>[] = [];
    const codeExecutor: CodeExecutor = {
      async execute(params) {
        codeEvents.push(params.event);
        return { success: true, durationMs: 1, apiCalls: [], logs: [] };
      },
    };

    const { u2App, env } = await getTestServer({
      codeExecutor,
      hooks: {
        onExecutePreUserRegistration: async (event) => {
          configEvents.push(event);
        },
      },
    });

    const action = await env.data.actions.create("tenantId", {
      name: "read-signup-fields",
      code: "exports.onExecutePreUserRegistration = async () => {};",
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });

    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data: {
            email: "custom-fields@example.com",
            password: "Password1!",
            re_password: "Password1!",
            "ulp-first-name": "Ada",
            unrelated: "must not be exposed",
          },
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(configEvents).toHaveLength(1);
    expect(configEvents[0]?.request.body).toEqual({
      "ulp-first-name": "Ada",
    });
    expect(codeEvents).toHaveLength(1);
    expect(
      (codeEvents[0]?.request as { body?: Record<string, unknown> }).body,
    ).toEqual({ "ulp-first-name": "Ada" });
  });

  it("shows config-hook validation errors on the HTML signup screen", async () => {
    const { u2App, env } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (_event, api) => {
          api.validation.error("missing_name", "Please enter your name");
        },
      },
    });
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start":
          '<div class="ulp-field"><input name="ulp-first-name" required></div>',
      },
    });
    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/signup?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: "validation-error@example.com",
          password: "Password1!",
          re_password: "Password1!",
          "ulp-first-name": "Ada",
        }).toString(),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Please enter your name");
    expect(body).toContain("validation-error@example.com");
    expect(body).toContain('name="ulp-first-name"');
    expect(body).toContain('value="Ada"');

    const { users } = await env.data.users.list("tenantId");
    expect(
      users.find((user) => user.email === "validation-error@example.com"),
    ).toBeUndefined();
  });

  it("shows code-hook validation errors in the JSON screen API and records a canceled execution", async () => {
    let createdExecution: ActionExecutionInsert | undefined;
    const { u2App, env } = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
      wrapDataAdapter: (data) => ({
        ...data,
        actionExecutions: {
          ...data.actionExecutions,
          create: async (tenantId, execution) => {
            createdExecution = execution;
            return data.actionExecutions.create(tenantId, execution);
          },
        },
      }),
    });

    const action = await env.data.actions.create("tenantId", {
      name: "validate-signup-fields",
      code: `
exports.onExecutePreUserRegistration = async (_event, api) => {
  api.validation.error("missing_name", "Please enter your name");
};
`,
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start": '<input name="ulp-first-name" required>',
      },
    });
    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data: {
            email: "code-validation-error@example.com",
            password: "Password1!",
            re_password: "Password1!",
            "ulp-first-name": "Ada",
          },
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.messages).toEqual([
      { text: "Please enter your name", type: "error" },
    ]);
    expect(
      body.screen.components.find((component) => component.id === "email")
        ?.config?.default_value,
    ).toBe("code-validation-error@example.com");
    expect(body.screen.partials?.["form-content-start"]).toContain(
      'value="Ada"',
    );
    expect(createdExecution).toMatchObject({
      trigger_id: "pre-user-registration",
      status: "canceled",
      results: [
        {
          action_name: action.id,
          error: { id: "missing_name", msg: "Please enter your name" },
        },
      ],
    });

    const { users } = await env.data.users.list("tenantId");
    expect(
      users.find((user) => user.email === "code-validation-error@example.com"),
    ).toBeUndefined();
  });

  it("preserves only email and string ulp-* values for a signup re-render", () => {
    expect(
      getSignupPrefill("prefill@example.com", {
        "ulp-first-name": "Ada",
        "ulp-age": 37,
        unrelated: "must not be retained",
        password: "must not be retained",
      }),
    ).toEqual({
      email: "prefill@example.com",
      "ulp-first-name": "Ada",
    });
  });

  it("HTML-escapes restored ulp-* values and leaves unrelated inputs alone", () => {
    expect(
      prefillPromptPartial(
        '<input name="ulp-first-name" value="Old"><input name="email" value="old@example.com"><input name="ulp-empty">',
        {
          "ulp-first-name": 'Ada "<&>',
          email: "new@example.com",
          password: "must-not-be-used",
        },
      ),
    ).toBe(
      '<input name="ulp-first-name" value="Ada &quot;&lt;&amp;&gt;"><input name="email" value="old@example.com"><input name="ulp-empty">',
    );
  });

  it("restores checked, textarea and selected state instead of overwriting values", () => {
    const html =
      '<input type="checkbox" name="ulp-tags" value="a" checked><input type="checkbox" name="ulp-tags" value="b">' +
      '<input type="radio" name="ulp-plan" value="free"><input type="radio" name="ulp-plan" value="pro">' +
      '<textarea name="ulp-bio">old</textarea>' +
      '<select name="ulp-country"><option value="se">SE</option><option value="no" selected>NO</option></select>';

    const result = prefillPromptPartial(html, {
      "ulp-tags": ["b"],
      "ulp-plan": "pro",
      "ulp-bio": "<hi>",
      "ulp-country": "se",
    });

    expect(result).toContain(
      '<input type="checkbox" name="ulp-tags" value="a">',
    );
    expect(result).toContain(
      '<input type="checkbox" name="ulp-tags" value="b" checked>',
    );
    expect(result).toContain(
      '<input type="radio" name="ulp-plan" value="free">',
    );
    expect(result).toContain(
      '<input type="radio" name="ulp-plan" value="pro" checked>',
    );
    expect(result).toContain('<textarea name="ulp-bio">&lt;hi&gt;</textarea>');
    expect(result).toContain('<option value="se" selected>');
    expect(result).not.toContain('<option value="no" selected>');
  });
});

describe("u2 signup partial enforcement and data-authhero-map", () => {
  const post = (
    u2App: Awaited<ReturnType<typeof getTestServer>>["u2App"],
    env: Awaited<ReturnType<typeof getTestServer>>["env"],
    stateId: string,
    fields: Record<string, string>,
  ) =>
    u2App.request(
      `/signup?state=${encodeURIComponent(stateId)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          password: "Password1!",
          re_password: "Password1!",
          ...fields,
        }).toString(),
      },
      env,
    );

  it("places errors on the ulp-field wrapper, reusing or adding ulp-error-info", () => {
    const { html, placed } = applyPartialErrors(
      '<div class="ulp-field"><label>First</label><input name="ulp-first"></div>' +
        '<div class="ulp-field x"><div><input name="ulp-last"></div><div class="ulp-error-info">old</div></div>' +
        '<input name="ulp-bare">',
      { "ulp-first": "Needed <b>", "ulp-last": "Bad", "ulp-bare": "Nope" },
    );
    expect(html).toContain(
      '<div class="ulp-field ulp-error"><label>First</label><input name="ulp-first"><div class="ulp-error-info">Needed &lt;b&gt;</div></div>',
    );
    expect(html).toContain('<div class="ulp-error-info">Bad</div>');
    expect(html).not.toContain("old");
    expect([...placed].sort()).toEqual(["ulp-first", "ulp-last"]);
  });

  it("only treats the exact ulp-error class token as an inline error", () => {
    const screen = (html: string) =>
      ({
        components: [],
        partials: { "form-content-start": html },
      }) as unknown as Parameters<typeof withHandlerError>[0];

    expect(
      withHandlerError(screen('<div class="ulp-error-info">x</div>'), "boom")
        .messages,
    ).toEqual([{ text: "boom", type: "error" }]);
    expect(
      withHandlerError(
        screen('<div class="ulp-field ulp-error"></div>'),
        "boom",
      ).messages,
    ).toBeUndefined();
  });

  it("rejects a missing required field and creates no user", async () => {
    const { u2App, env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start": '<input name="ulp-first-name" required>',
      },
    });
    const session = await seedSignupSession(env);

    const response = await post(u2App, env, session.id, {
      email: "required@example.com",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("ulp-first-name is required");
  });

  it("shows the required error inline on the ulp-field in the screen API", async () => {
    const { u2App, env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start":
          '<div class="ulp-field"><input name="ulp-first-name" required></div>',
      },
    });
    const session = await seedSignupSession(env);
    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(session.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data: {
            email: "inline@example.com",
            password: "Password1!",
            re_password: "Password1!",
          },
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.partials?.["form-content-start"]).toContain(
      'class="ulp-field ulp-error"',
    );
    expect(body.screen.partials?.["form-content-start"]).toContain(
      '<div class="ulp-error-info">ulp-first-name is required</div>',
    );
    expect(body.screen.messages).toBeUndefined();
    const { users } = await env.data.users.list("tenantId");
    expect(users.find((u) => u.email === "inline@example.com")).toBeUndefined();
  });

  it("enforces maxlength and pattern", async () => {
    const { u2App, env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start":
          '<input name="ulp-zip" maxlength="5" pattern="[0-9]+">',
      },
    });
    const session = await seedSignupSession(env);

    const tooLong = await post(u2App, env, session.id, {
      email: "len@example.com",
      "ulp-zip": "123456",
    });
    expect(tooLong.status).toBe(400);
    const badPattern = await post(u2App, env, session.id, {
      email: "pat@example.com",
      "ulp-zip": "abcde",
    });
    expect(badPattern.status).toBe(400);
  });

  it("maps allowlisted targets from the stored partial onto the user", async () => {
    const events: HookEvent[] = [];
    const { u2App, env } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (event) => {
          events.push(event);
        },
      },
    });
    await env.data.promptPartials?.set("tenantId", "signup", {
      signup: {
        "form-content-start":
          '<input name="ulp-first-name" data-authhero-map="given_name" required>' +
          '<input name="ulp-company" data-authhero-map="user_metadata.company">' +
          '<input name="ulp-evil" data-authhero-map="email_verified">' +
          '<input name="ulp-evil2" data-authhero-map="app_metadata.role">',
      },
    });
    const session = await seedSignupSession(env);

    const response = await post(u2App, env, session.id, {
      email: "mapped@example.com",
      "ulp-first-name": "Ada",
      "ulp-company": "Acme",
      "ulp-evil": "true",
      "ulp-evil2": "admin",
      // Tampering: browser-supplied mapping and extra fields are ignored.
      "data-authhero-map": "family_name",
      family_name: "Hacker",
      given_name: "Hacker",
    });

    expect(response.status).toBe(302);
    const { users } = await env.data.users.list("tenantId");
    const user = users.find((u) => u.email === "mapped@example.com");
    expect(user?.given_name).toBe("Ada");
    expect(user?.family_name).toBeUndefined();
    expect(user?.email_verified).toBe(false);
    expect(user?.user_metadata).toEqual({ company: "Acme" });
    expect(user?.app_metadata).not.toHaveProperty("role");
    expect(events[0]?.user.given_name).toBe("Ada");
  });
});
