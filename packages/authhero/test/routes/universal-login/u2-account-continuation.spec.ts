/**
 * The form-hook `account` redirect target lands on the u2 account hub
 * mid-login: the login session carries the `account` continuation scope
 * instead of the user having a session cookie.
 */
import { describe, it, expect } from "vitest";
import { LoginSession, LoginSessionState } from "@authhero/adapter-interfaces";
import { hasValidContinuationScope } from "../../../src/authentication-flows/common";
import { getTestServer } from "../../helpers/test-server";
import { getRedirectUrl } from "../../../src/hooks/formhooks";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

type ScreenJson = {
  redirect?: string;
  screen?: {
    name?: string;
    action?: string;
    links?: Array<{ id: string; href: string; text?: string }>;
    components: Array<{
      id: string;
      type: string;
      config?: { content?: string; text?: string };
    }>;
  };
};

const USER_ID = "email|userId";
const USER_EMAIL = "foo@example.com";
const SESSION_COOKIE = "tenantId-auth-token=account-session";

async function setup(options: { continuation?: boolean } = {}) {
  const server = await getTestServer({ mockEmail: true });
  const { env } = server;
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
    },
  });
  await env.data.sessions.create("tenantId", {
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
  if (options.continuation) {
    await env.data.loginSessions.update("tenantId", loginSession.id, {
      user_id: USER_ID,
      session_id: "account-session",
      state: LoginSessionState.AWAITING_CONTINUATION,
      state_data: JSON.stringify({
        continuationScope: ["account"],
        continuationReturnUrl: `/u2/continue?state=${loginSession.id}`,
      }),
    });
  }
  return { ...server, state: loginSession.id };
}

async function getScreen(
  server: TestServer,
  screenId: string,
  state: string,
  headers: Record<string, string> = {},
) {
  const response = await server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}`,
    { headers: { "tenant-id": "tenantId", ...headers } },
    server.env,
  );
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    json: (text.startsWith("{") ? JSON.parse(text) : {}) as ScreenJson,
  };
}

async function postScreen(
  server: TestServer,
  screenId: string,
  state: string,
  data: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const response = await server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ data }),
    },
    server.env,
  );
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    json: (text ? JSON.parse(text) : {}) as ScreenJson,
  };
}

describe("u2 account hub mid-login", () => {
  it("is where form hooks send account", () => {
    expect(getRedirectUrl("account", undefined, "abc")).toBe(
      "/u2/account?state=abc",
    );
  });

  it("renders without a session cookie, with change-email and continue", async () => {
    const server = await setup({ continuation: true });
    const { state } = server;

    const html = await server.u2App.request(
      `/account?state=${encodeURIComponent(state)}`,
      {},
      server.env,
    );
    expect(html.status).toBe(200);

    const { status, json } = await getScreen(server, "account", state);
    expect(status).toBe(200);
    const components = json.screen!.components;
    expect(components.map((c) => c.id)).toEqual([
      "user-info",
      "nav-links",
      "continue",
    ]);
    expect(components[0]!.config?.content).toContain(USER_EMAIL);
    const nav = components[1]!.config?.content ?? "";
    expect(nav).toContain(
      `/u2/account/change-email?state=${encodeURIComponent(state)}`,
    );
    // Sub-screens that need a signed-in session are not offered
    expect(nav).not.toContain("/account/profile");
    expect(nav).not.toContain("/account/security");
    expect(JSON.stringify(json)).not.toContain("/account/delete");
    // Logging out would abandon the login
    expect(json.screen!.links ?? []).toEqual([]);
    expect(components[2]!.type).toBe("NEXT_BUTTON");
  });

  it("continues the login when the continue button is pressed", async () => {
    const server = await setup({ continuation: true });
    const result = await postScreen(server, "account", server.state, {});
    expect(result.json.redirect).toBe(`/u2/continue?state=${server.state}`);

    const resumed = await server.u2App.request(
      result.json.redirect!.replace(/^\/u2/, ""),
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(resumed.status).toBe(302);
    expect(resumed.headers.get("location")).toContain(
      "https://example.com/callback",
    );
  });

  it("changes the email from the hub and comes back to it", async () => {
    const server = await setup({ continuation: true });
    const { env, state } = server;

    const step1 = await getScreen(server, "account-change-email", state);
    expect(step1.status).toBe(200);
    expect(step1.json.screen?.links?.[0]?.href).toBe(
      `/u2/account?state=${encodeURIComponent(state)}`,
    );

    const request = await postScreen(server, "account-change-email", state, {
      email: "hub@example.com",
    });
    expect(request.json.redirect).toBe(
      `/u2/account/change-email/verify?state=${encodeURIComponent(state)}`,
    );
    const code = server.getSentEmails().at(-1)?.data.code as string;

    const ok = await postScreen(server, "account-change-email-verify", state, {
      code,
    });
    // The verify POST redirects to the verify GET, which renders the
    // confirmation; its continue link goes back to the hub, which then
    // offers to continue the login.
    expect(ok.json.redirect).toBe(
      `/u2/account/change-email/verify?state=${encodeURIComponent(state)}`,
    );
    const done = await getScreen(server, "account-change-email-verify", state);
    expect(done.status).toBe(200);
    expect(done.json.screen?.links?.[0]?.href).toBe(
      `/u2/account?state=${encodeURIComponent(state)}`,
    );
    expect((await env.data.users.get("tenantId", USER_ID))?.email).toBe(
      "hub@example.com",
    );
  });

  it("does not open the other account screens", async () => {
    const server = await setup({ continuation: true });
    const profile = await server.u2App.request(
      `/account/profile?state=${encodeURIComponent(server.state)}`,
      {},
      server.env,
    );
    expect(profile.status).toBe(302);
    expect(profile.headers.get("location")).toContain("/u2/login");
  });

  it("does not accept an expired continuation", async () => {
    const server = await setup({ continuation: true });
    await server.env.data.loginSessions.update("tenantId", server.state, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    for (const path of ["/account", "/account/change-email"]) {
      const response = await server.u2App.request(
        `${path}?state=${encodeURIComponent(server.state)}`,
        {},
        server.env,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/u2/login");
    }
    const post = await postScreen(server, "account", server.state, {});
    // Continue doesn't resume the login either: the user is sent to log in.
    expect(post.status).toBe(302);
    expect(post.location).toContain("/u2/login");
  });

  it("does not accept a continuation scoped to change-email only", async () => {
    const server = await setup({ continuation: true });
    await server.env.data.loginSessions.update("tenantId", server.state, {
      state_data: JSON.stringify({
        continuationScope: ["change-email"],
        continuationReturnUrl: `/u2/continue?state=${server.state}`,
      }),
    });
    const response = await server.u2App.request(
      `/account?state=${encodeURIComponent(server.state)}`,
      {},
      server.env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/u2/login");
  });
});

describe("u2 account hub signed in", () => {
  it("still shows every section and the logout link", async () => {
    const server = await setup();
    const { json } = await getScreen(server, "account", server.state, {
      cookie: SESSION_COOKIE,
    });
    expect(json.screen!.components.map((c) => c.id)).toEqual([
      "user-info",
      "nav-links",
      "danger-zone",
    ]);
    expect(json.screen!.components[1]!.config?.content).toContain(
      "/account/profile",
    );
    expect(json.screen!.links?.map((l) => l.id)).toEqual(["logout"]);
  });

  it("sends a signed-out user to the login page", async () => {
    const server = await setup();
    const response = await server.u2App.request(
      `/account?state=${encodeURIComponent(server.state)}`,
      {},
      server.env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/u2/login");
  });

  it("posting the hub without a continuation just shows it again", async () => {
    const server = await setup();
    const result = await postScreen(
      server,
      "account",
      server.state,
      {},
      { cookie: SESSION_COOKIE },
    );
    expect(result.json.redirect).toBe(
      `/u2/account?state=${encodeURIComponent(server.state)}`,
    );
  });
});

describe("hasValidContinuationScope", () => {
  const base = {
    state: LoginSessionState.AWAITING_CONTINUATION,
    state_data: JSON.stringify({ continuationScope: ["account"] }),
  };

  it("accepts an unexpired continuation with the scope", () => {
    expect(
      hasValidContinuationScope(
        {
          ...base,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        } as LoginSession,
        "account",
      ),
    ).toBe(true);
  });

  it("rejects an expired or unparseable expiry", () => {
    for (const expires_at of [
      new Date(Date.now() - 1000).toISOString(),
      "not a date",
    ]) {
      expect(
        hasValidContinuationScope(
          { ...base, expires_at } as LoginSession,
          "account",
        ),
      ).toBe(false);
    }
  });
});
