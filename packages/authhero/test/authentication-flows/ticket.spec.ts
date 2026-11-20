import { describe, it, expect } from "vitest";
import { getTestServer } from "../helpers/test-server";
import { testClient } from "hono/testing";
import { nanoid } from "nanoid";
import bcryptjs from "bcryptjs";
import { generateCodeVerifier } from "../../src/utils/crypto";
import { USERNAME_PASSWORD_PROVIDER } from "../../src/constants";
import {
  AuthorizationResponseType,
  Strategy,
} from "@authhero/adapter-interfaces";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;

async function createTicket(
  env: TestServer["env"],
  connection: string | undefined,
  username = "foo@example.com",
) {
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour from now
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      username,
      redirect_uri: "https://example.com/callback",
      connection,
    },
  });

  const co_id = nanoid(12);
  const co_verifier = generateCodeVerifier();

  return env.data.codes.create("tenantId", {
    code_id: nanoid(32),
    code_type: "ticket",
    login_id: loginSession.id,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    code_verifier: [co_id, co_verifier].join("|"),
  });
}

async function createPasswordUser(env: TestServer["env"]) {
  await env.data.users.create("tenantId", {
    email: "foo@example.com",
    email_verified: true,
    name: "Test User",
    nickname: "Test User",
    connection: Strategy.USERNAME_PASSWORD,
    provider: USERNAME_PASSWORD_PROVIDER,
    is_social: false,
    user_id: `${USERNAME_PASSWORD_PROVIDER}|userId`,
  });
  await env.data.passwords.create("tenantId", {
    user_id: `${USERNAME_PASSWORD_PROVIDER}|userId`,
    password: await bcryptjs.hash("Test1234!", 10),
    algorithm: "bcrypt",
  });
}

async function loginForTicket({ oauthApp, env }: TestServer) {
  const oauthClient = testClient(oauthApp, env);
  const loginResponse = await oauthClient.co.authenticate.$post({
    json: {
      client_id: "clientId",
      credential_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: Strategy.USERNAME_PASSWORD,
      password: "Test1234!",
      username: "foo@example.com",
    },
  });
  expect(loginResponse.status).toBe(200);
  const body: unknown = await loginResponse.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("login_ticket" in body) ||
    typeof body.login_ticket !== "string"
  ) {
    throw new Error("no login_ticket from /co/authenticate");
  }
  return body.login_ticket;
}

describe("ticket", () => {
  it("should return a auth response for a valid ticket", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);

    const ticket = await createTicket(env, undefined);

    const response = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          login_ticket: ticket.code_id,
          realm: Strategy.USERNAME_PASSWORD,
          response_type: AuthorizationResponseType.CODE,
        },
      },
      {
        headers: {
          origin: "https://example.com",
        },
      },
    );

    expect(response.status).toEqual(302);
  });

  it("redeems a ticket from /co/authenticate in the connection that verified the password", async () => {
    const server = await getTestServer();
    const { oauthApp, env } = server;
    const oauthClient = testClient(oauthApp, env);
    await createPasswordUser(env);

    const login_ticket = await loginForTicket(server);

    const ticket = await env.data.codes.get("tenantId", login_ticket, "ticket");
    if (!ticket?.login_id) throw new Error("ticket has no login session");
    const loginSession = await env.data.loginSessions.get(
      "tenantId",
      ticket.login_id,
    );
    expect(loginSession?.authParams.connection).toBe(
      Strategy.USERNAME_PASSWORD,
    );

    const response = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket,
        realm: Strategy.USERNAME_PASSWORD,
        response_type: AuthorizationResponseType.CODE,
        redirect_uri: "https://example.com/callback",
        state: "state",
      },
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    if (!location) throw new Error("no redirect from /authorize");
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("no code in redirect");

    const authCode = await env.data.codes.get(
      "tenantId",
      code,
      "authorization_code",
    );
    expect(authCode?.user_id).toBe(`${USERNAME_PASSWORD_PROVIDER}|userId`);
  });

  it("rejects a ticket redeemed for the email realm when a passwordless user has the same email", async () => {
    const server = await getTestServer();
    const { oauthApp, env } = server;
    const oauthClient = testClient(oauthApp, env);
    await createPasswordUser(env);
    // The test server seeds a passwordless user for the same email.
    const passwordlessUser = await env.data.users.get(
      "tenantId",
      "email|userId",
    );
    expect(passwordlessUser?.email).toBe("foo@example.com");

    const login_ticket = await loginForTicket(server);

    const response = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket,
        realm: Strategy.EMAIL,
        response_type: AuthorizationResponseType.CODE,
        redirect_uri: "https://example.com/callback",
        state: "state",
      },
    });

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ message: "Invalid realm" });

    // The ticket is spent: it can't be retried in any realm.
    const retry = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket,
        realm: Strategy.USERNAME_PASSWORD,
        response_type: AuthorizationResponseType.CODE,
        redirect_uri: "https://example.com/callback",
        state: "state",
      },
    });
    expect(retry.status).toBe(403);
  });

  it("rejects a ticket redeemed for the email realm when no user has that email", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);

    const ticket = await createTicket(env, undefined, "new@example.com");

    const response = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket: ticket.code_id,
        realm: Strategy.EMAIL,
        response_type: AuthorizationResponseType.CODE,
        redirect_uri: "https://example.com/callback",
        state: "state",
      },
    });

    expect(response.status).toBe(403);
    const { users } = await env.data.users.list("tenantId", {
      q: "email:new@example.com",
    });
    expect(users).toHaveLength(0);
  });

  it("rejects a ticket redeemed for another realm", async () => {
    const { oauthApp, env } = await getTestServer();
    const oauthClient = testClient(oauthApp, env);
    await createPasswordUser(env);

    // A ticket whose password was verified in a different connection.
    const ticket = await createTicket(env, "other-database");

    const response = await oauthClient.authorize.$get({
      query: {
        client_id: "clientId",
        login_ticket: ticket.code_id,
        realm: Strategy.USERNAME_PASSWORD,
        response_type: AuthorizationResponseType.CODE,
        redirect_uri: "https://example.com/callback",
        state: "state",
      },
    });

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ message: "Invalid realm" });
  });
});
