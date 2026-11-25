/**
 * #1733: the flows that used to send users to /u because /u2 had no screen
 * for them. The test client has no `universal_login_version`, i.e. it is a
 * client that still runs /u; these links now go to /u2 for every client.
 */
import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseType,
  LoginSessionState,
  Strategy,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { getRedirectUrl } from "../../../src/hooks/formhooks";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

type ScreenJson = {
  redirect?: string;
  screen?: {
    name?: string;
    action?: string;
    title?: string;
    description?: string;
    messages?: Array<{ text: string; type: string }>;
    links?: Array<{ id: string; href: string; text?: string }>;
    components: Array<{
      id: string;
      type: string;
      messages?: Array<{ text: string; type: string }>;
    }>;
  };
};

const USER_ID = "email|userId";
const USER_EMAIL = "foo@example.com";
const SESSION_COOKIE = "tenantId-auth-token=account-session";

async function startLogin(server: TestServer, username?: string) {
  const { env, oauthApp } = server;
  const authorizeResponse = await testClient(oauthApp, env).authorize.$get({
    query: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      state: "client-state",
      nonce: "nonce",
      scope: "openid email profile",
      response_type: AuthorizationResponseType.CODE,
    },
  });
  const location = authorizeResponse.headers.get("location")!;
  const state = new URL(`https://example.com${location}`).searchParams.get(
    "state",
  )!;
  if (username) {
    const loginSession = await env.data.loginSessions.get("tenantId", state);
    await env.data.loginSessions.update("tenantId", state, {
      authParams: { ...loginSession!.authParams, username },
    });
  }
  return state;
}

async function getScreen(
  server: TestServer,
  screenId: string,
  state: string,
  headers: Record<string, string> = {},
) {
  return server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}`,
    { headers: { "tenant-id": "tenantId", ...headers } },
    server.env,
  );
}

async function postScreen(
  server: TestServer,
  screenId: string,
  state: string,
  data: Record<string, string>,
  headers: Record<string, string> = {},
  query = "",
): Promise<{ status: number; location: string | null; json: ScreenJson }> {
  const response = await server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}${query}`,
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
    json: text ? JSON.parse(text) : {},
  };
}

describe("/u2/error", () => {
  it("renders the error page that /u/error renders", async () => {
    const server = await getTestServer();
    for (const app of [server.u2App, server.universalApp]) {
      const response = await app.request(
        "/error?error=access_denied&error_description=Not%20allowed",
        { headers: { "tenant-id": "tenantId" } },
        server.env,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Not allowed");
    }
  });

  it("is where the callback sends an unknown state", async () => {
    const server = await getTestServer();
    const response = await server.oauthApp.request(
      "/callback?state=unknown&code=code",
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/u2/error");
    expect(location.searchParams.get("error")).toBe("state_not_found");
  });
});

describe("/u2/invalid-session", () => {
  it("offers a way back to the client with an invalid_session error", async () => {
    const server = await getTestServer();
    const state = await startLogin(server, USER_EMAIL);

    const html = await server.u2App.request(
      `/invalid-session?state=${encodeURIComponent(state)}`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(html.status).toBe(200);

    const response = await getScreen(server, "invalid-session", state);
    expect(response.status).toBe(200);
    const { screen } = (await response.json()) as ScreenJson;
    expect(screen?.title).toBe("Invalid link");
    const back = new URL(screen!.links!.find((l) => l.id === "back")!.href);
    expect(back.origin + back.pathname).toBe("https://example.com/callback");
    expect(back.searchParams.get("error")).toBe("invalid_session");
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("is where an unusable passwordless link lands", async () => {
    const server = await getTestServer();
    const response = await server.oauthApp.request(
      `/passwordless/verify_redirect?${new URLSearchParams({
        scope: "openid",
        response_type: "code",
        redirect_uri: "https://example.com/callback",
        state: "client-state",
        nonce: "nonce",
        verification_code: "000000",
        connection: "email",
        client_id: "clientId",
        email: USER_EMAIL,
      })}`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/u2/invalid-session");
    // The screen shows `error`, so it must be the plain user-safe message
    const error = location.searchParams.get("error");
    expect(error).toBeTruthy();
    expect(error).not.toMatch(/^\{/);

    // The redirect target renders for this /u client
    const page = await server.u2App.request(
      `/invalid-session${location.search}`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(page.status).toBe(200);
  });
});

describe("u2 signup with a pre-signup code", () => {
  async function setup() {
    const server = await getTestServer({ mockEmail: true });
    const { env } = server;
    await env.data.clientConnections.updateByClient("tenantId", "clientId", [
      Strategy.USERNAME_PASSWORD,
      "email",
    ]);
    const email = "new-user@example.com";
    const state = await startLogin(server, email);
    return { ...server, email, state };
  }

  async function mintCode(server: TestServer, loginId: string) {
    const code = await server.env.data.codes.create("tenantId", {
      code_id: "123456",
      code_type: "email_verification",
      login_id: loginId,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    return code.code_id;
  }

  const password = "MyStr0ng#Password1";

  it("links the signup email to /u2/signup and verifies the address", async () => {
    const server = await setup();
    const { env, email, state, universalApp, getSentEmails } = server;

    // The pre-signup flow is still started from /u
    const preSignup = await universalApp.request(
      `/pre-signup?state=${encodeURIComponent(state)}`,
      { method: "POST" },
      env,
    );
    expect(preSignup.status).toBe(302);
    const signupUrl = new URL(
      getSentEmails().find((e) => e.data.signupUrl)!.data.signupUrl,
    );
    expect(signupUrl.pathname).toBe("/u2/signup");
    expect(signupUrl.searchParams.get("state")).toBe(state);
    const code = signupUrl.searchParams.get("code")!;

    // The code is kept on the form action so the POST sees it
    const screen = await server.u2App.request(
      `/screen/signup${signupUrl.search}`,
      {},
      env,
    );
    const { screen: signupScreen } = (await screen.json()) as ScreenJson;
    expect(signupScreen?.action).toContain(`code=${encodeURIComponent(code)}`);

    const emailsBefore = getSentEmails().length;
    const result = await postScreen(
      server,
      "signup",
      state,
      { email, password, re_password: password },
      {},
      `&code=${encodeURIComponent(code)}`,
    );
    expect(result.json.redirect).toBeDefined();

    const { users } = await env.data.users.list("tenantId", {
      q: `email:${email}`,
    });
    expect(users).toHaveLength(1);
    expect(users[0]!.email_verified).toBe(true);
    // Already verified: no verification email on top of the pre-signup one
    expect(getSentEmails()).toHaveLength(emailsBefore);
    const stored = await env.data.codes.get(
      "tenantId",
      code,
      "email_verification",
    );
    expect(stored?.used_at).toBeTruthy();
  });

  it("works through the no-JS form post", async () => {
    const server = await setup();
    const { env, email, state } = server;
    const code = await mintCode(server, state);

    const response = await server.u2App.request(
      `/signup?state=${encodeURIComponent(state)}&code=${code}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email,
          password,
          re_password: password,
        }).toString(),
      },
      env,
    );
    expect(response.status).toBe(302);
    const { users } = await env.data.users.list("tenantId", {
      q: `email:${email}`,
    });
    expect(users[0]!.email_verified).toBe(true);
  });

  it("ignores a code for another address or session", async () => {
    const server = await setup();
    const { env, state } = server;
    const otherState = await startLogin(server, "someone@example.com");
    const otherCode = await mintCode(server, otherState);

    // Code from another login session
    await postScreen(
      server,
      "signup",
      state,
      { email: server.email, password, re_password: password },
      {},
      `&code=${otherCode}`,
    );
    const { users } = await env.data.users.list("tenantId", {
      q: `email:${server.email}`,
    });
    expect(users[0]!.email_verified).toBe(false);
    expect(
      (await env.data.codes.get("tenantId", otherCode, "email_verification"))
        ?.used_at,
    ).toBeFalsy();

    // Right session, but the submitted email isn't the verified one
    const thirdState = await startLogin(server, "verified@example.com");
    const code = await env.data.codes.create("tenantId", {
      code_id: "654321",
      code_type: "email_verification",
      login_id: thirdState,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await postScreen(
      server,
      "signup",
      thirdState,
      { email: "different@example.com", password, re_password: password },
      {},
      `&code=${code.code_id}`,
    );
    const { users: different } = await env.data.users.list("tenantId", {
      q: "email:different@example.com",
    });
    expect(different[0]!.email_verified).toBe(false);
  });

  it("keeps old /u/signup links from emails already sent working", async () => {
    const server = await setup();
    const code = await mintCode(server, server.state);
    const response = await server.universalApp.request(
      `/signup?state=${encodeURIComponent(server.state)}&code=${code}`,
      {},
      server.env,
    );
    expect(response.status).toBe(200);
  });
});

describe("u2 change email", () => {
  async function setup(
    options: { continuation?: boolean; screenHint?: boolean } = {},
  ) {
    const server = await getTestServer({ mockEmail: true });
    const { env } = server;
    const loginSession = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      csrf_token: "csrf",
      authParams: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
      },
      ...(options.screenHint
        ? {
            authorization_url:
              "https://example.com/account?client_id=clientId&screen_hint=change-email",
          }
        : {}),
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
          continuationScope: ["change-email"],
          continuationReturnUrl: `/u2/continue?state=${loginSession.id}`,
        }),
      });
    }
    return { ...server, state: loginSession.id };
  }

  const cookie = { cookie: SESSION_COOKIE };

  async function requestCode(
    server: TestServer & { state: string },
    email: string,
    headers: Record<string, string> = cookie,
  ) {
    const result = await postScreen(
      server,
      "account-change-email",
      server.state,
      { email },
      headers,
    );
    const sent = server.getSentEmails().at(-1);
    return { result, code: sent?.data.code as string, sent };
  }

  it("changes the email after the code sent to the new address is entered", async () => {
    const server = await setup();
    const { env, state } = server;

    const html = await server.u2App.request(
      `/account/change-email?state=${encodeURIComponent(state)}`,
      { headers: cookie },
      env,
    );
    expect(html.status).toBe(200);

    const { result, code, sent } = await requestCode(
      server,
      " New@Example.com ",
    );
    expect(result.json.redirect).toBe(
      `/u2/account/change-email/verify?state=${encodeURIComponent(state)}`,
    );
    expect(sent.to).toBe("new@example.com");
    expect(code).toMatch(/^\d{6}$/);

    const verify = await getScreen(
      server,
      "account-change-email-verify",
      state,
      cookie,
    );
    expect(((await verify.json()) as ScreenJson).screen?.description).toContain(
      "ne***@example.com",
    );

    const wrong = await postScreen(
      server,
      "account-change-email-verify",
      state,
      { code: code === "000000" ? "111111" : "000000" },
      cookie,
    );
    expect(wrong.status).toBe(400);
    expect((await env.data.users.get("tenantId", USER_ID))?.email).toBe(
      USER_EMAIL,
    );

    const ok = await postScreen(
      server,
      "account-change-email-verify",
      state,
      { code },
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(ok.json.screen?.title).toBe("Email changed");
    expect(ok.json.screen?.links?.[0]?.href).toBe(
      `/u2/account?state=${encodeURIComponent(state)}`,
    );

    const user = await env.data.users.get("tenantId", USER_ID);
    expect(user?.email).toBe("new@example.com");
    expect(user?.email_verified).toBe(true);

    // The code can't be used twice: with nothing pending the user is sent
    // back to step 1
    const again = await postScreen(
      server,
      "account-change-email-verify",
      state,
      { code },
      cookie,
    );
    expect(again.status).toBe(302);
    expect(again.location).toContain("/u2/account/change-email?state=");
  });

  it("only reveals that an address is taken once its code is entered", async () => {
    const server = await setup();
    const { env, state } = server;
    await env.data.users.create("tenantId", {
      user_id: "email|other",
      email: "taken@example.com",
      email_verified: true,
      connection: "email",
      provider: "email",
      is_social: false,
    });

    const { result, code } = await requestCode(server, "taken@example.com");
    expect(result.json.redirect).toContain("/u2/account/change-email/verify");

    const verify = await postScreen(
      server,
      "account-change-email-verify",
      state,
      { code },
      cookie,
    );
    expect(verify.status).toBe(400);
    expect(JSON.stringify(verify.json)).toContain("can't be used");
    expect((await env.data.users.get("tenantId", USER_ID))?.email).toBe(
      USER_EMAIL,
    );
  });

  it("rejects a code minted for another login session", async () => {
    const server = await setup();
    const { env } = server;
    const { code } = await requestCode(server, "new@example.com");

    const other = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      csrf_token: "csrf",
      authParams: { client_id: "clientId" },
      state_data: JSON.stringify({
        pending_email_change: { email: "new@example.com" },
      }),
    });
    const result = await postScreen(
      server,
      "account-change-email-verify",
      other.id,
      { code },
      cookie,
    );
    expect(result.status).toBe(400);
    expect((await env.data.users.get("tenantId", USER_ID))?.email).toBe(
      USER_EMAIL,
    );
  });

  it("sends a signed-out user to the login page", async () => {
    const server = await setup();
    const response = await server.u2App.request(
      `/account/change-email?state=${encodeURIComponent(server.state)}`,
      {},
      server.env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/u2/login");
  });

  it("works mid-login from a form hook and continues the login", async () => {
    const server = await setup({ continuation: true });
    const { env, state } = server;

    const html = await server.u2App.request(
      `/account/change-email?state=${encodeURIComponent(state)}`,
      {},
      env,
    );
    expect(html.status).toBe(200);

    const { code } = await requestCode(server, "mid-login@example.com", {});
    const ok = await postScreen(
      server,
      "account-change-email-verify",
      state,
      { code },
      {},
    );
    expect(ok.status).toBe(200);
    expect(ok.json.screen?.links?.[0]?.href).toBe(
      `/u2/continue?state=${state}`,
    );
    expect((await env.data.users.get("tenantId", USER_ID))?.email).toBe(
      "mid-login@example.com",
    );
  });

  it("returns to the application after screen_hint=change-email", async () => {
    const server = await setup({ screenHint: true });
    const { code } = await requestCode(server, "hint@example.com");
    const ok = await postScreen(
      server,
      "account-change-email-verify",
      server.state,
      { code },
      cookie,
    );
    expect(ok.json.screen?.links?.[0]?.href).toBe(
      "https://example.com/callback",
    );
  });

  it("is where form hooks send change-email", () => {
    expect(getRedirectUrl("change-email", undefined, "abc")).toBe(
      "/u2/account/change-email?state=abc",
    );
  });
});
