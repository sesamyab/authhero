import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import {
  AuthorizationResponseType,
  Strategy,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { u2Screen } from "../helpers/u2-screen";

// #1703: which database connection password login, signup and reset use when
// a client enables several, the way Auth0 decides it:
// - a connection the request names (/authorize `connection`, password-realm
//   `realm`, /dbconnections `connection`) when the client enables it, and a
//   rejection when it doesn't;
// - otherwise the client's first enabled database connection;
// - for a client without an explicit list, the tenant's oldest.

const LOGIN_DB = "Username-Password-Authentication"; // seeded, oldest
const CTE_DB = "cte-store";
// Sorts after the seeded connection's id, so a created_at tie still orders the
// seeded connection first.
const CTE_DB_ID = "zz-cte-store";
const PASSWORD = "fG%D0MV4bjb%xI";
const CALLBACK = "https://example.com/callback";

async function setup() {
  const server = await getTestServer({ testTenantLanguage: "en" });
  const { env } = server;
  // Created after the seeded connection. If both rows get the same created_at
  // millisecond, the fallback order breaks the tie on id, and CTE_DB_ID sorts
  // after the seeded id, so the seeded connection is still the oldest.
  await env.data.connections.create("tenantId", {
    id: CTE_DB_ID,
    name: CTE_DB,
    strategy: "auth0",
    options: {},
  });
  for (const [client_id, connections] of [
    // Both database connections, the CTE one first.
    ["cteFirstClient", [CTE_DB_ID, LOGIN_DB, "email"]],
    // Both, the login one first.
    ["loginFirstClient", [LOGIN_DB, CTE_DB_ID, "email"]],
    // Only the login database: the CTE connection is not enabled.
    ["loginOnlyClient", [LOGIN_DB, "email"]],
    // Only the CTE database: no connection carries the generic name.
    ["cteOnlyClient", [CTE_DB_ID, "email"]],
  ] as const) {
    await env.data.clients.create("tenantId", {
      client_id,
      client_secret: `${client_id}Secret`,
      name: client_id,
      callbacks: [CALLBACK],
      allowed_logout_urls: [CALLBACK],
      web_origins: ["https://example.com"],
      client_metadata: { email_validation: "disabled" },
    });
    await env.data.clientConnections.updateByClient("tenantId", client_id, [
      ...connections,
    ]);
  }

  const oauthClient = testClient(server.oauthApp, env);

  const signup = (client_id: string, email: string, connection: string) =>
    oauthClient.dbconnections.signup.$post(
      { json: { email, password: PASSWORD, connection, client_id } },
      { headers: { "tenant-id": "tenantId" } },
    );

  const coAuthenticate = (client_id: string, username: string, realm: string) =>
    oauthClient.co.authenticate.$post({
      json: {
        client_id,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm,
        password: PASSWORD,
        username,
      },
    });

  const authorize = (client_id: string, connection?: string) =>
    oauthClient.authorize.$get({
      query: {
        client_id,
        redirect_uri: CALLBACK,
        state: "state",
        nonce: "nonce",
        scope: "openid email profile",
        response_type: AuthorizationResponseType.CODE,
        ...(connection ? { connection } : {}),
      },
    });

  async function createUser(
    connection: string,
    email: string,
    provider = "auth0",
  ) {
    const user_id = `${provider}|${connection}-${email}`;
    await env.data.users.create("tenantId", {
      user_id,
      email,
      email_verified: true,
      provider,
      connection,
      is_social: false,
    });
    await env.data.passwords.create("tenantId", {
      user_id,
      password: await bcryptjs.hash(PASSWORD, 4),
      algorithm: "bcrypt",
    });
    return user_id;
  }

  /** /authorize, then the u2 password screen, as a browser would. */
  async function u2PasswordLogin(
    client_id: string,
    username: string,
    connection?: string,
  ) {
    const response = await authorize(client_id, connection);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    const state = new URL(location, "https://example.com").searchParams.get(
      "state",
    );
    if (!state) throw new Error("No state");
    const loginSession = await env.data.loginSessions.get("tenantId", state);
    if (!loginSession) throw new Error("No login session");
    loginSession.authParams.username = username;
    await env.data.loginSessions.update("tenantId", state, loginSession);
    return u2Screen(server.u2App, env, "enter-password").$post({
      query: { state },
      form: { password: PASSWORD },
    });
  }

  return {
    ...server,
    signup,
    coAuthenticate,
    authorize,
    createUser,
    u2PasswordLogin,
  };
}

async function storedConnection(
  env: Awaited<ReturnType<typeof setup>>["env"],
  response: Response,
) {
  expect(response.status).toBe(200);
  const body: { _id: string } = await response.json();
  return (await env.data.users.get("tenantId", body._id))?.connection;
}

describe("database connection selection (#1703)", () => {
  it("lets a client enable several database connections", async () => {
    const { managementApp, env } = await setup();
    const token = await getAdminToken();
    const request = (method: string, path: string, body: unknown) =>
      managementApp.request(
        path,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": "tenantId",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        env,
      );

    expect(
      (
        await request("PATCH", "/clients/clientId/connections", [
          LOGIN_DB,
          CTE_DB_ID,
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PATCH", `/connections/${CTE_DB_ID}/clients`, [
          { client_id: "loginOnlyClient", status: true },
        ])
      ).status,
    ).toBe(204);
    expect(
      (await env.data.clients.get("tenantId", "loginOnlyClient"))?.connections,
    ).toEqual([LOGIN_DB, "email", CTE_DB_ID]);
  });

  describe("without a named connection", () => {
    it("uses the client's first database connection", async () => {
      const { env, signup } = await setup();
      expect(
        await storedConnection(
          env,
          await signup("cteFirstClient", "a@example.com", LOGIN_DB),
        ),
      ).toBe(LOGIN_DB); // the literal names the enabled login connection
      expect(
        await storedConnection(
          env,
          await signup("loginFirstClient", "b@example.com", LOGIN_DB),
        ),
      ).toBe(LOGIN_DB);
    });

    it("uses the first in client order for universal login", async () => {
      const { createUser, u2PasswordLogin } = await setup();
      await createUser(CTE_DB, "cte-user@example.com");

      // cteFirstClient's default is the CTE connection, loginFirstClient's
      // the login one, which doesn't hold this user.
      expect(
        (await u2PasswordLogin("cteFirstClient", "cte-user@example.com"))
          .status,
      ).toBe(302);
      const refused = await u2PasswordLogin(
        "loginFirstClient",
        "cte-user@example.com",
      );
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("Wrong");
    });

    it("uses the tenant's oldest database connection for a client without an explicit list", async () => {
      const { env, signup, createUser, u2PasswordLogin } = await setup();
      expect(
        await storedConnection(
          env,
          await signup("clientId", "c@example.com", LOGIN_DB),
        ),
      ).toBe(LOGIN_DB);

      await createUser(CTE_DB, "cte-only@example.com");
      // The oldest is the login connection, which doesn't hold this user.
      expect(
        (await u2PasswordLogin("clientId", "cte-only@example.com")).status,
      ).toBe(400);
    });

    it("never logs in to a CTE connection the client doesn't enable", async () => {
      const { env, signup, createUser, u2PasswordLogin } = await setup();
      await createUser(CTE_DB, "cte-user@example.com");

      expect(
        (await u2PasswordLogin("loginOnlyClient", "cte-user@example.com"))
          .status,
      ).toBe(400);
      expect(
        await storedConnection(
          env,
          await signup("loginOnlyClient", "d@example.com", LOGIN_DB),
        ),
      ).toBe(LOGIN_DB);
    });
  });

  describe("a named connection", () => {
    it("picks it on /authorize and universal login uses it", async () => {
      const { env, authorize, createUser, u2PasswordLogin } = await setup();
      await createUser(CTE_DB, "cte-user@example.com");

      const response = await authorize("loginFirstClient", CTE_DB);
      expect(response.status).toBe(302);
      const state = new URL(
        response.headers.get("location") ?? "",
        "https://example.com",
      ).searchParams.get("state");
      const loginSession = await env.data.loginSessions.get(
        "tenantId",
        state ?? "",
      );
      expect(loginSession?.authParams.connection).toBe(CTE_DB);

      const login = await u2PasswordLogin(
        "loginFirstClient",
        "cte-user@example.com",
        CTE_DB,
      );
      expect(login.status).toBe(302);
      expect(login.headers.get("location")).toContain("code=");
    });

    it("is refused on /authorize when the client doesn't enable it", async () => {
      const { authorize } = await setup();
      expect((await authorize("loginOnlyClient", CTE_DB)).status).toBe(403);
    });

    it("picks it as the password-realm realm, and refuses one the client doesn't enable", async () => {
      const { coAuthenticate, createUser } = await setup();
      await createUser(CTE_DB, "cte-user@example.com");

      expect(
        (
          await coAuthenticate(
            "loginFirstClient",
            "cte-user@example.com",
            CTE_DB,
          )
        ).status,
      ).toBe(200);
      // The default (login) connection doesn't hold the user.
      expect(
        (
          await coAuthenticate(
            "loginFirstClient",
            "cte-user@example.com",
            LOGIN_DB,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await coAuthenticate(
            "loginOnlyClient",
            "cte-user@example.com",
            CTE_DB,
          )
        ).status,
      ).toBe(400);
    });

    it("redeems a login ticket for a named realm in that connection", async () => {
      const { env, coAuthenticate, createUser, oauthApp } = await setup();
      const userId = await createUser(CTE_DB, "cte-user@example.com");

      const login = await coAuthenticate(
        "loginFirstClient",
        "cte-user@example.com",
        CTE_DB,
      );
      expect(login.status).toBe(200);
      const body: { login_ticket: string } = await login.json();

      const response = await testClient(oauthApp, env).authorize.$get({
        query: {
          client_id: "loginFirstClient",
          login_ticket: body.login_ticket,
          realm: CTE_DB,
          response_type: AuthorizationResponseType.CODE,
          redirect_uri: CALLBACK,
          scope: "openid",
          state: "state",
          nonce: "nonce",
        },
      });
      expect(response.status).toBe(302);
      const code = new URL(
        response.headers.get("location") ?? "",
      ).searchParams.get("code");
      expect(code).toBeTruthy();
      const stored = await env.data.codes.get(
        "tenantId",
        code ?? "",
        "authorization_code",
      );
      expect(stored?.user_id).toBe(userId);
    });

    describe("a login ticket is bound to the connection its password was verified in", () => {
      // A cte-store user shares an email with a user of another connection.
      // The ticket only covers the cte-store password, so redeeming it in
      // another connection must not log in (or create) that connection's user.
      async function ticketFor(
        server: Awaited<ReturnType<typeof setup>>,
        email: string,
      ) {
        const login = await server.coAuthenticate(
          "cteFirstClient",
          email,
          CTE_DB,
        );
        expect(login.status).toBe(200);
        const body: { login_ticket: string } = await login.json();
        return body.login_ticket;
      }

      function redeem(
        server: Awaited<ReturnType<typeof setup>>,
        login_ticket: string,
        realm: string,
      ) {
        return testClient(server.oauthApp, server.env).authorize.$get({
          query: {
            client_id: "cteFirstClient",
            login_ticket,
            realm,
            response_type: AuthorizationResponseType.CODE,
            redirect_uri: CALLBACK,
            scope: "openid",
            state: "state",
            nonce: "nonce",
          },
        });
      }

      async function usersWithEmail(
        server: Awaited<ReturnType<typeof setup>>,
        email: string,
      ) {
        const { users } = await server.env.data.users.list("tenantId", {
          q: `email:${email}`,
        });
        return users.map((u) => u.user_id).sort();
      }

      it("refuses a redeem as the existing user of another database connection", async () => {
        const server = await setup();
        // Until #1704 two database users can't share an email under one
        // provider; a legacy `auth2` row in the login connection can.
        const loginUser = await server.createUser(
          LOGIN_DB,
          "shared@example.com",
          "auth2",
        );
        const cteUser = await server.createUser(CTE_DB, "shared@example.com");
        const ticket = await ticketFor(server, "shared@example.com");

        const response = await redeem(server, ticket, LOGIN_DB);
        expect(response.status).toBe(403);
        expect(response.headers.get("location")).toBeNull();
        expect(await usersWithEmail(server, "shared@example.com")).toEqual(
          [cteUser, loginUser].sort(),
        );
      });

      it("refuses a redeem with a realm that resolves to the default connection, without creating a user", async () => {
        const server = await setup();
        // cteFirstClient's default is cte-store; loginFirstClient's would be
        // the login connection. Use a ticket from a client whose default is
        // the login connection but whose password was checked in cte-store.
        const cteUser = await server.createUser(CTE_DB, "new@example.com");
        const login = await server.coAuthenticate(
          "loginFirstClient",
          "new@example.com",
          CTE_DB,
        );
        expect(login.status).toBe(200);
        const body: { login_ticket: string } = await login.json();

        const response = await testClient(
          server.oauthApp,
          server.env,
        ).authorize.$get({
          query: {
            client_id: "loginFirstClient",
            login_ticket: body.login_ticket,
            realm: Strategy.USERNAME_PASSWORD,
            response_type: AuthorizationResponseType.CODE,
            redirect_uri: CALLBACK,
            scope: "openid",
            state: "state",
            nonce: "nonce",
          },
        });
        expect(response.status).toBe(403);
        expect(await usersWithEmail(server, "new@example.com")).toEqual([
          cteUser,
        ]);
      });

      it("refuses a redeem as a passwordless user (realm=email)", async () => {
        const server = await setup();
        const cteUser = await server.createUser(CTE_DB, "otp@example.com");
        await server.env.data.users.create("tenantId", {
          user_id: "email|otp-user",
          email: "otp@example.com",
          email_verified: true,
          provider: "email",
          connection: "email",
          is_social: false,
        });
        const ticket = await ticketFor(server, "otp@example.com");

        const response = await redeem(server, ticket, "email");
        expect(response.status).toBe(403);
        expect(await usersWithEmail(server, "otp@example.com")).toEqual(
          [cteUser, "email|otp-user"].sort(),
        );
      });
    });

    it("refuses a ticket whose login session got its connection from /authorize", async () => {
      const { env, createUser, oauthApp } = await setup();
      const cteUser = await createUser(CTE_DB, "hinted@example.com");
      const client = testClient(oauthApp, env);

      // /authorize records the requested connection and the login_hint, but
      // checks no password.
      const started = await client.authorize.$get({
        query: {
          client_id: "cteFirstClient",
          redirect_uri: CALLBACK,
          state: "state",
          nonce: "nonce",
          scope: "openid",
          response_type: AuthorizationResponseType.CODE,
          connection: CTE_DB,
          login_hint: "hinted@example.com",
        },
      });
      expect(started.status).toBe(302);
      const state =
        new URL(
          started.headers.get("location") ?? "",
          "https://example.com",
        ).searchParams.get("state") ?? "";
      const loginSession = await env.data.loginSessions.get("tenantId", state);
      expect(loginSession?.authParams.connection).toBe(CTE_DB);

      // A ticket pointing at that session, even one that names the user.
      const ticket = await env.data.codes.create("tenantId", {
        code_id: "ticket-for-authorize-session",
        code_type: "ticket",
        login_id: state,
        user_id: cteUser,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });

      const response = await client.authorize.$get({
        query: {
          client_id: "cteFirstClient",
          login_ticket: ticket.code_id,
          realm: CTE_DB,
          response_type: AuthorizationResponseType.CODE,
          redirect_uri: CALLBACK,
          scope: "openid",
          state: "state2",
          nonce: "nonce",
        },
      });
      expect(response.status).toBe(403);
    });

    it("redeems a login ticket as the user whose password was verified", async () => {
      const { env, coAuthenticate, oauthApp } = await setup();
      // A legacy row whose connection names no database connection: the
      // cte-store lookup finds it while no row is stored in cte-store itself.
      await env.data.users.create("tenantId", {
        user_id: "auth2|legacy",
        email: "pinned@example.com",
        email_verified: true,
        provider: "auth2",
        connection: "auth2",
        is_social: false,
      });
      await env.data.passwords.create("tenantId", {
        user_id: "auth2|legacy",
        password: await bcryptjs.hash(PASSWORD, 4),
        algorithm: "bcrypt",
      });
      const login = await coAuthenticate(
        "cteFirstClient",
        "pinned@example.com",
        CTE_DB,
      );
      expect(login.status).toBe(200);
      const body: { login_ticket: string } = await login.json();

      // A row stored in cte-store itself now takes precedence for the same
      // email, but its password was never checked.
      await env.data.users.create("tenantId", {
        user_id: "auth0|later",
        email: "pinned@example.com",
        email_verified: true,
        provider: "auth0",
        connection: CTE_DB,
        is_social: false,
      });

      const response = await testClient(oauthApp, env).authorize.$get({
        query: {
          client_id: "cteFirstClient",
          login_ticket: body.login_ticket,
          realm: CTE_DB,
          response_type: AuthorizationResponseType.CODE,
          redirect_uri: CALLBACK,
          scope: "openid",
          state: "state",
          nonce: "nonce",
        },
      });
      expect(response.status).toBe(302);
      const code = new URL(
        response.headers.get("location") ?? "",
      ).searchParams.get("code");
      const stored = await env.data.codes.get(
        "tenantId",
        code ?? "",
        "authorization_code",
      );
      expect(stored?.user_id).toBe("auth2|legacy");
    });

    it("picks it for /dbconnections signup, and refuses one the client doesn't enable", async () => {
      const { env, signup } = await setup();
      expect(
        await storedConnection(
          env,
          await signup("loginFirstClient", "e@example.com", CTE_DB),
        ),
      ).toBe(CTE_DB);
      expect(
        (await signup("loginOnlyClient", "f@example.com", CTE_DB)).status,
      ).toBe(400);
      expect(
        await env.data.users.list("tenantId", { q: "email:f@example.com" }),
      ).toMatchObject({ users: [] });
    });
  });

  it("treats the generic name on /authorize as the client's default database connection", async () => {
    const { env, authorize } = await setup();
    const response = await authorize("cteOnlyClient", LOGIN_DB);
    expect(response.status).toBe(302);
    const state = new URL(
      response.headers.get("location") ?? "",
      "https://example.com",
    ).searchParams.get("state");
    const loginSession = await env.data.loginSessions.get(
      "tenantId",
      state ?? "",
    );
    expect(loginSession?.authParams.connection).toBe(CTE_DB);
  });

  it("records the connection a password reset targets on its session", async () => {
    const { env, u2App } = await setup();
    const loginSession = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 600000).toISOString(),
      csrf_token: "csrfToken",
      authParams: {
        client_id: "cteFirstClient",
        redirect_uri: CALLBACK,
        scope: "openid",
        response_type: AuthorizationResponseType.CODE,
        state: "state",
        nonce: "nonce",
      },
    });

    const response = await u2App.request(
      `/screen/forgot-password?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "reset@example.com" }).toString(),
      },
      env,
    );
    expect(response.status).toBe(200);

    const stored = await env.data.loginSessions.get(
      "tenantId",
      loginSession.id,
    );
    expect(stored?.authParams.connection).toBe(CTE_DB);
    const { users } = await env.data.users.list("tenantId", {
      q: "email:reset@example.com",
    });
    expect(users.map((u) => u.connection)).toEqual([CTE_DB]);
  });

  it("keeps universal login on the generic realm for clients that name none", async () => {
    const { createUser, u2PasswordLogin } = await setup();
    await createUser(LOGIN_DB, "main-user@example.com");
    expect(
      (await u2PasswordLogin("loginFirstClient", "main-user@example.com"))
        .status,
    ).toBe(302);
    expect(Strategy.USERNAME_PASSWORD).toBe(LOGIN_DB);
  });
});
