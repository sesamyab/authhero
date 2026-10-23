import { describe, expect, it } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import {
  AuthorizationResponseType,
  Strategy,
} from "@authhero/adapter-interfaces";
import type { HookEvent } from "../../../src/types/Hooks";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";
import { getTestServer } from "../../helpers/test-server";
import { u2Screen } from "../../helpers/u2-screen";
import {
  LOGIN_SCREEN_PARTIAL_SOURCES,
  withPartials,
} from "../../../src/routes/universal-login/screens/partials";
import type { ScreenContext } from "../../../src/routes/universal-login/screens/types";

type ScreenBody = {
  screen: {
    name: string;
    messages?: { text: string; type: string }[];
    partials?: Record<string, string>;
  };
};

const FIELD =
  '<div class="ulp-field"><input name="ulp-first-name" required></div>';

async function seedSession(
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

const getScreen = async (
  screen: string,
  setup: (
    env: Awaited<ReturnType<typeof getTestServer>>["env"],
  ) => Promise<void>,
) => {
  const { u2App, env } = await getTestServer();
  await setup(env);
  const session = await seedSession(env);
  const response = await u2App.request(
    `/screen/${screen}?state=${encodeURIComponent(session.id)}`,
    { headers: { "tenant-id": "tenantId" } },
    env,
  );
  return { response, body: (await response.json()) as ScreenBody };
};

describe("login prompt partials", () => {
  it.each([
    ["identifier", "login-id", "login-id"],
    ["login", "login", "login"],
  ])("renders %s partials from the %s prompt", async (screen, prompt, key) => {
    const { response, body } = await getScreen(screen, async (env) => {
      await env.data.promptPartials?.set("tenantId", prompt, {
        [key]: { "form-content-start": FIELD },
        other: { "form-content-end": "must not render" },
      });
    });
    expect(response.status).toBe(200);
    expect(body.screen.partials).toEqual({ "form-content-start": FIELD });
  });

  it("does not render another prompt's partials", async () => {
    const { body } = await getScreen("identifier", async (env) => {
      await env.data.promptPartials?.set("tenantId", "login-password", {
        "login-password": { "form-content-start": FIELD },
      });
    });
    expect(body.screen.partials).toBeUndefined();
  });

  it("rejects a missing required field inline on the identifier screen", async () => {
    const { u2App, env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "login-id", {
      "login-id": { "form-content-start": FIELD },
    });
    const session = await seedSession(env);
    const response = await u2App.request(
      `/screen/identifier?state=${encodeURIComponent(session.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({ data: { username: "foo@example.com" } }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.name).toBe("identifier");
    expect(body.screen.partials?.["form-content-start"]).toContain(
      '<div class="ulp-error-info">ulp-first-name is required</div>',
    );
  });
});

describe("login step transitions", () => {
  it("attaches the next screen's partials when a step advances", async () => {
    const { env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "login-password", {
      "login-password": { "form-footer-end": "<p>terms</p>" },
    });
    const screen = (name: string) => ({
      screen: { name, action: "", method: "POST" as const, components: [] },
    });
    const definition = withPartials(
      {
        id: "identifier",
        name: "Identifier",
        handler: {
          get: async () => screen("identifier"),
          // Handlers build the next step by calling its factory directly.
          post: async () => ({ screen: screen("enter-password") }),
        },
      },
      LOGIN_SCREEN_PARTIAL_SOURCES.identifier!,
    );
    const context = {
      ctx: { env, set: () => {} },
      tenant: { id: "tenantId" },
    } as unknown as ScreenContext;

    const result = await definition.handler.post!(context, {});

    expect("screen" in result && result.screen.screen.partials).toEqual({
      "form-footer-end": "<p>terms</p>",
    });
  });
});

describe("signup-id / signup-password partials", () => {
  it("merges signup-id, signup and signup-password partials on the signup screen", async () => {
    const { body } = await getScreen("signup", async (env) => {
      await env.data.promptPartials?.set("tenantId", "signup-id", {
        "signup-id": { "form-content-start": "<p>id</p>" },
      });
      await env.data.promptPartials?.set("tenantId", "signup", {
        signup: { "form-content-start": "<p>signup</p>" },
      });
      await env.data.promptPartials?.set("tenantId", "signup-password", {
        "signup-password": {
          "form-content-start": "<p>password</p>",
          "form-footer-end": "<p>footer</p>",
        },
      });
    });
    expect(body.screen.partials).toEqual({
      "form-content-start": "<p>id</p><p>signup</p><p>password</p>",
      "form-footer-end": "<p>footer</p>",
    });
  });
});

describe("login partial fields", () => {
  const USERNAME = "victim@example.com";
  const PASSWORD = "CorrectPassword123!";
  const USER_ID = `${USERNAME_PASSWORD_PROVIDER}|victim`;

  const field = (name: string, extra = "") =>
    `<div class="ulp-field"><input name="${name}" ${extra}></div>`;

  async function setup(
    partials: Record<string, Record<string, Record<string, string>>>,
    user: Record<string, unknown> = {},
  ) {
    const { u2App, oauthApp, env } = await getTestServer();
    const events: HookEvent[] = [];
    env.hooks = {
      onExecutePostLogin: async (event: HookEvent) => {
        events.push(event);
      },
    };
    for (const [prompt, value] of Object.entries(partials)) {
      await env.data.promptPartials?.set("tenantId", prompt, value);
    }
    await env.data.users.create("tenantId", {
      email: USERNAME,
      email_verified: true,
      connection: Strategy.USERNAME_PASSWORD,
      provider: USERNAME_PASSWORD_PROVIDER,
      is_social: false,
      user_id: USER_ID,
      ...user,
    });
    await env.data.passwords.create("tenantId", {
      user_id: USER_ID,
      password: await bcryptjs.hash(PASSWORD, 10),
      algorithm: "bcrypt",
    });

    const authorize = await testClient(oauthApp, env).authorize.$get({
      query: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        state: "state",
        response_type: AuthorizationResponseType.CODE,
      },
    });
    const state = new URL(
      `https://example.com${authorize.headers.get("location")}`,
    ).searchParams.get("state")!;
    const loginSession = await env.data.loginSessions.get("tenantId", state);
    loginSession!.authParams.username = USERNAME;
    await env.data.loginSessions.update("tenantId", state, loginSession!);

    const post = (screen: string, form: Record<string, string>) =>
      u2Screen(u2App, env, screen).$post({ query: { state }, form });
    return { env, events, post, state, u2App };
  }

  const passwordPartial = (html: string) => ({
    "login-password": { "login-password": { "form-content-end": html } },
  });

  it("passes only ulp-* fields to the post-login hook", async () => {
    const { post, events } = await setup(
      passwordPartial(field("ulp-company", 'maxlength="5"')),
    );
    const response = await post("enter-password", {
      password: PASSWORD,
      "ulp-company": "Acme",
      unrelated: "nope",
    });
    expect(response.status).toBe(302);
    expect(events).toHaveLength(1);
    expect(events[0]!.request.body).toEqual({ "ulp-company": "Acme" });
  });

  it("leaves the hook body undefined when no ulp-* field is submitted", async () => {
    const { post, events } = await setup(passwordPartial(field("ulp-company")));
    const response = await post("enter-password", { password: PASSWORD });
    expect(response.status).toBe(302);
    expect(events[0]!.request.body).toBeUndefined();
  });

  it("enforces maxlength and pattern before logging in", async () => {
    const { post, events } = await setup(
      passwordPartial(
        field("ulp-company", 'maxlength="5"') +
          field("ulp-code", 'pattern="[0-9]+"'),
      ),
    );
    const tooLong = await post("enter-password", {
      password: PASSWORD,
      "ulp-company": "far too long",
    });
    expect(tooLong.status).not.toBe(302);
    const badPattern = await post("enter-password", {
      password: PASSWORD,
      "ulp-code": "abc",
    });
    expect(badPattern.status).not.toBe(302);
    expect(events).toHaveLength(0);
  });

  it("rejects a missing required field and keeps the other values", async () => {
    const { post, events } = await setup(
      passwordPartial(
        field("ulp-first-name", "required") + field("ulp-company"),
      ),
    );
    const response = await post("enter-password", {
      password: PASSWORD,
      "ulp-company": "Acme",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("ulp-first-name is required");
    expect(html).toContain('value="Acme"');
    expect(events).toHaveLength(0);
  });

  it("maps allowlisted targets from the stored partial onto the user", async () => {
    const { post, env } = await setup(
      passwordPartial(
        field("ulp-first-name", 'data-authhero-map="given_name"') +
          field("ulp-plan", 'data-authhero-map="user_metadata.plan"') +
          field("ulp-unmapped"),
      ),
      { user_metadata: { keep: "me", plan: "old" } },
    );
    const response = await post("enter-password", {
      password: PASSWORD,
      "ulp-first-name": "Ada",
      "ulp-plan": "pro",
      "ulp-unmapped": "ignored",
    });
    expect(response.status).toBe(302);
    const user = await env.data.users.get("tenantId", USER_ID);
    expect(user?.given_name).toBe("Ada");
    expect(user?.user_metadata).toEqual({ keep: "me", plan: "pro" });
  });

  it("ignores mapping attributes that are not in the stored partial", async () => {
    const { post, env } = await setup(passwordPartial(field("ulp-first-name")));
    await post("enter-password", {
      password: PASSWORD,
      "ulp-first-name": "Ada",
      "data-authhero-map": "given_name",
      given_name: "Mallory",
    });
    const user = await env.data.users.get("tenantId", USER_ID);
    expect(user?.given_name).toBeUndefined();
  });

  it("carries fields from the identifier step to the hook and the mapping", async () => {
    const { post, events, env } = await setup({
      "login-id": {
        "login-id": {
          "form-content-end": field(
            "ulp-first-name",
            'data-authhero-map="given_name"',
          ),
        },
      },
    });
    const first = await post("login/identifier", {
      username: USERNAME,
      "ulp-first-name": "Ada",
    });
    expect(first.status).toBeLessThan(400);
    const second = await post("enter-password", { password: PASSWORD });
    expect(second.status).toBe(302);
    expect(events[0]!.request.body).toEqual({ "ulp-first-name": "Ada" });
    const user = await env.data.users.get("tenantId", USER_ID);
    expect(user?.given_name).toBe("Ada");
  });

  it("never stores password controls on the login session", async () => {
    const { post, env, state } = await setup(
      passwordPartial(
        field("ulp-pin", 'type="password"') + field("ulp-company"),
      ),
    );
    await post("enter-password", {
      password: "wrong-password-1!",
      "ulp-pin": "1234",
      "ulp-company": "Acme",
    });
    const session = await env.data.loginSessions.get("tenantId", state);
    expect(JSON.parse(session?.state_data ?? "{}").partial_fields).toEqual({
      "ulp-company": "Acme",
    });
  });

  it("applies the same rules on the combined login screen", async () => {
    const { post, events, env } = await setup({
      login: {
        login: {
          "form-content-end": field(
            "ulp-first-name",
            'required data-authhero-map="given_name"',
          ),
        },
      },
    });
    await env.data.connections.update("tenantId", Strategy.USERNAME_PASSWORD, {
      strategy: Strategy.USERNAME_PASSWORD,
    });
    const missing = await post("login", {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(missing.status).toBe(400);
    const ok = await post("login", {
      username: USERNAME,
      password: PASSWORD,
      "ulp-first-name": "Ada",
    });
    expect(ok.status).toBe(302);
    expect(events[0]!.request.body).toEqual({ "ulp-first-name": "Ada" });
    expect((await env.data.users.get("tenantId", USER_ID))?.given_name).toBe(
      "Ada",
    );
  });
});
