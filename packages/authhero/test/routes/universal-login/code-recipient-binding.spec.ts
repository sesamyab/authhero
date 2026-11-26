/**
 * Login and pre-signup codes may only be redeemed for the address they were
 * sent to, even when the login session's username changes afterwards.
 */
import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseType,
  Strategy,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

const OTHER_EMAIL = "other@example.com";
// Seeded by the test server
const EXISTING_EMAIL = "foo@example.com";
const password = "MyStr0ng#Password1";

async function setup() {
  const server = await getTestServer({ mockEmail: true });
  const { env } = server;
  await env.data.connections.update("tenantId", "email", {
    options: { authentication_method: "code" },
  });
  await env.data.clientConnections.updateByClient("tenantId", "clientId", [
    "email",
  ]);
  return server;
}

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
  if (username) await setUsername(server, state, username);
  return state;
}

async function setUsername(
  server: TestServer,
  state: string,
  username: string,
) {
  const loginSession = await server.env.data.loginSessions.get(
    "tenantId",
    state,
  );
  await server.env.data.loginSessions.update("tenantId", state, {
    authParams: { ...loginSession!.authParams, username },
  });
}

async function postScreen(
  server: TestServer,
  screenId: string,
  state: string,
  data: Record<string, string>,
  query = "",
) {
  const response = await server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}${query}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    },
    server.env,
  );
  return (await response.json()) as {
    redirect?: string;
    screen?: { name?: string };
  };
}

function lastCodeTo(server: TestServer, to: string): string {
  const email = server
    .getSentEmails()
    .filter((e) => e.to === to && e.data.code)
    .pop();
  expect(email).toBeDefined();
  return email!.data.code;
}

describe("login codes are bound to their recipient (u2)", () => {
  it("rejects a code sent to an address the session no longer uses", async () => {
    const server = await setup();
    const state = await startLogin(server);

    await postScreen(server, "identifier", state, { username: OTHER_EMAIL });
    const firstCode = lastCodeTo(server, OTHER_EMAIL);

    await postScreen(server, "identifier", state, {
      username: EXISTING_EMAIL,
    });

    const result = await postScreen(server, "email-otp-challenge", state, {
      code: firstCode,
    });
    expect(result.redirect ?? "").not.toContain("example.com/callback");
    expect(result.screen?.name).toBe("email-otp-challenge");

    // The earlier code was retired when the username changed
    const stored = await server.env.data.codes.get(
      "tenantId",
      firstCode,
      "otp",
    );
    expect(stored?.used_at).toBeTruthy();

    // The code sent to the current address still works
    const secondCode = lastCodeTo(server, EXISTING_EMAIL);
    const ok = await postScreen(server, "email-otp-challenge", state, {
      code: secondCode,
    });
    expect(ok.redirect).toContain("https://example.com/callback");
  });

  it("rejects a code for another address even if it was not retired", async () => {
    const server = await setup();
    const state = await startLogin(server);

    await postScreen(server, "identifier", state, { username: OTHER_EMAIL });
    const code = lastCodeTo(server, OTHER_EMAIL);
    // Change the username without the identifier step, so nothing retires it
    await setUsername(server, state, EXISTING_EMAIL);

    const result = await postScreen(server, "email-otp-challenge", state, {
      code,
    });
    expect(result.redirect ?? "").not.toContain("example.com/callback");
    expect(
      (await server.env.data.codes.get("tenantId", code, "otp"))?.used_at,
    ).toBeFalsy();
  });

  it("rejects a code minted without a stored recipient", async () => {
    const server = await setup();
    const state = await startLogin(server, EXISTING_EMAIL);
    await server.env.data.codes.create("tenantId", {
      code_id: "123456",
      code_type: "otp",
      login_id: state,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });

    const result = await postScreen(server, "email-otp-challenge", state, {
      code: "123456",
    });
    expect(result.redirect ?? "").not.toContain("example.com/callback");
  });
});

describe("login codes are bound to their recipient (/u)", () => {
  it("rejects a code sent to an address the session no longer uses", async () => {
    const server = await setup();
    const universalClient = testClient(server.universalApp, server.env);
    const state = await startLogin(server);

    await universalClient.login.identifier.$post({
      query: { state },
      form: { username: OTHER_EMAIL },
    });
    const firstCode = lastCodeTo(server, OTHER_EMAIL);

    await universalClient.login.identifier.$post({
      query: { state },
      form: { username: EXISTING_EMAIL },
    });

    const response = await universalClient.login["email-otp-challenge"].$post({
      query: { state },
      form: { code: firstCode },
    });
    expect(response.status).toBe(400);

    const secondCode = lastCodeTo(server, EXISTING_EMAIL);
    const ok = await universalClient.login["email-otp-challenge"].$post({
      query: { state },
      form: { code: secondCode },
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain(
      "https://example.com/callback",
    );
  });

  it("rejects a code for another address even if it was not retired", async () => {
    const server = await setup();
    const universalClient = testClient(server.universalApp, server.env);
    const state = await startLogin(server);

    await universalClient.login.identifier.$post({
      query: { state },
      form: { username: OTHER_EMAIL },
    });
    const code = lastCodeTo(server, OTHER_EMAIL);
    await setUsername(server, state, EXISTING_EMAIL);

    const response = await universalClient.login["email-otp-challenge"].$post({
      query: { state },
      form: { code },
    });
    expect(response.status).toBe(400);
    expect(
      (await server.env.data.codes.get("tenantId", code, "otp"))?.used_at,
    ).toBeFalsy();
  });
});

describe("pre-signup codes are bound to their recipient", () => {
  async function setupSignup() {
    const server = await getTestServer({ mockEmail: true });
    await server.env.data.clientConnections.updateByClient(
      "tenantId",
      "clientId",
      [Strategy.USERNAME_PASSWORD, "email"],
    );
    return server;
  }

  async function sendPreSignupCode(server: TestServer, state: string) {
    const response = await server.universalApp.request(
      `/pre-signup?state=${encodeURIComponent(state)}`,
      { method: "POST" },
      server.env,
    );
    expect(response.status).toBe(302);
    const signupUrl = new URL(
      server.getSentEmails().find((e) => e.data.signupUrl)!.data.signupUrl,
    );
    return signupUrl.searchParams.get("code")!;
  }

  async function isVerified(server: TestServer, email: string) {
    const { users } = await server.env.data.users.list("tenantId", {
      q: `email:${email}`,
    });
    expect(users).toHaveLength(1);
    return users[0]!.email_verified;
  }

  it("u2 signup does not verify another address with the code", async () => {
    const server = await setupSignup();
    const state = await startLogin(server, OTHER_EMAIL);
    const code = await sendPreSignupCode(server, state);

    const target = "target@example.com";
    await setUsername(server, state, target);

    await postScreen(
      server,
      "signup",
      state,
      { email: target, password, re_password: password },
      `&code=${encodeURIComponent(code)}`,
    );
    expect(await isVerified(server, target)).toBe(false);
    const stored = await server.env.data.codes.get(
      "tenantId",
      code,
      "email_verification",
    );
    expect(stored?.used_at).toBeFalsy();
  });

  it("u2 signup still verifies the address the code was sent to", async () => {
    const server = await setupSignup();
    const state = await startLogin(server, OTHER_EMAIL);
    const code = await sendPreSignupCode(server, state);

    // The session moved on, but the address submitted is the one proven
    await setUsername(server, state, "target@example.com");
    await setUsername(server, state, OTHER_EMAIL);

    await postScreen(
      server,
      "signup",
      state,
      { email: OTHER_EMAIL, password, re_password: password },
      `&code=${encodeURIComponent(code)}`,
    );
    expect(await isVerified(server, OTHER_EMAIL)).toBe(true);
  });

  it("legacy /u/signup does not verify another address with the code", async () => {
    const server = await setupSignup();
    const state = await startLogin(server, OTHER_EMAIL);
    const code = await sendPreSignupCode(server, state);

    const target = "target@example.com";
    await setUsername(server, state, target);

    await server.universalApp.request(
      `/signup?state=${encodeURIComponent(state)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          password,
          "re-enter-password": password,
          code,
        }).toString(),
      },
      server.env,
    );
    expect(await isVerified(server, target)).toBe(false);
  });

  it("legacy /u/validate-email does not accept a code sent to another address", async () => {
    const server = await setupSignup();
    const attackerState = await startLogin(server, OTHER_EMAIL);
    const code = await sendPreSignupCode(server, attackerState);

    const victimEmail = "victim@example.com";
    await server.env.data.users.create("tenantId", {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|victim`,
      email: victimEmail,
      email_verified: false,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      is_social: false,
    });
    const victimState = await startLogin(server, victimEmail);

    await server.universalApp.request(
      `/validate-email?state=${encodeURIComponent(victimState)}&code=${encodeURIComponent(code)}`,
      {},
      server.env,
    );
    const user = await server.env.data.users.get(
      "tenantId",
      `${USERNAME_PASSWORD_PROVIDER}|victim`,
    );
    expect(user?.email_verified).toBe(false);
  });
});
