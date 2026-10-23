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

describe("login hook body", () => {
  const USERNAME = "victim@example.com";
  const PASSWORD = "CorrectPassword123!";

  async function loginWithPassword(fields: Record<string, string>) {
    const { u2App, oauthApp, env } = await getTestServer();
    const events: HookEvent[] = [];
    env.hooks = {
      onExecutePostLogin: async (event: HookEvent) => {
        events.push(event);
      },
    };
    await env.data.promptPartials?.set("tenantId", "login-password", {
      "login-password": {
        "form-content-end":
          '<div class="ulp-field"><input name="ulp-company" maxlength="5"></div>',
      },
    });
    await env.data.users.create("tenantId", {
      email: USERNAME,
      email_verified: true,
      connection: Strategy.USERNAME_PASSWORD,
      provider: USERNAME_PASSWORD_PROVIDER,
      is_social: false,
      user_id: `${USERNAME_PASSWORD_PROVIDER}|victim`,
    });
    await env.data.passwords.create("tenantId", {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|victim`,
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

    const response = await u2Screen(u2App, env, "enter-password").$post({
      query: { state },
      form: { password: PASSWORD, ...fields },
    });
    return { response, events };
  }

  it("passes only ulp-* fields to the post-login hook", async () => {
    const { response, events } = await loginWithPassword({
      "ulp-company": "Acme",
      unrelated: "nope",
    });
    expect(response.status).toBe(302);
    expect(events).toHaveLength(1);
    expect(events[0]!.request.body).toEqual({ "ulp-company": "Acme" });
  });

  it("leaves the hook body undefined when no ulp-* field is submitted", async () => {
    const { response, events } = await loginWithPassword({});
    expect(response.status).toBe(302);
    expect(events).toHaveLength(1);
    expect(events[0]!.request.body).toBeUndefined();
  });

  it("enforces maxlength from the stored partial before logging in", async () => {
    const { response, events } = await loginWithPassword({
      "ulp-company": "far too long",
    });
    expect(response.status).not.toBe(302);
    expect(events).toHaveLength(0);
  });
});
