import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

// #1702 review: signup, login and the stored connection must agree on a
// tenant with two database connections, for a client whose only database
// connection is the second one.

const MAIN = "Username-Password-Authentication";
const CTE = "cte-store";
const CTE_CLIENT = "cteClient";
const PASSWORD = "fG%D0MV4bjb%xI";

async function setup() {
  const server = await getTestServer();
  const { env } = server;
  await env.data.connections.create("tenantId", {
    id: CTE,
    name: CTE,
    strategy: "auth0",
    options: {},
  });
  await env.data.clients.create("tenantId", {
    client_id: CTE_CLIENT,
    client_secret: "cteClientSecret",
    name: "CTE Client",
    callbacks: ["https://example.com/callback"],
    allowed_logout_urls: ["https://example.com/callback"],
    web_origins: ["https://example.com"],
    client_metadata: { email_validation: "disabled" },
  });
  await env.data.clientConnections.updateByClient("tenantId", CTE_CLIENT, [
    CTE,
  ]);
  const oauthClient = testClient(server.oauthApp, env);

  const signup = (client_id: string, email: string) =>
    oauthClient.dbconnections.signup.$post(
      {
        json: {
          email,
          password: PASSWORD,
          connection: Strategy.USERNAME_PASSWORD,
          client_id,
        },
      },
      { headers: { "tenant-id": "tenantId" } },
    );

  const login = (client_id: string, username: string) =>
    oauthClient.co.authenticate.$post({
      json: {
        client_id,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: Strategy.USERNAME_PASSWORD,
        password: PASSWORD,
        username,
      },
    });

  return { ...server, signup, login };
}

describe("database connection scope across signup and login (#1702)", () => {
  it("stores the client's database connection on signup and logs in through the same client", async () => {
    const { env, signup, login } = await setup();

    const response = await signup(CTE_CLIENT, "cte-signup@example.com");
    expect(response.status).toBe(200);
    const created = await response.json();

    const stored = await env.data.users.get("tenantId", created._id);
    expect(stored?.connection).toBe(CTE);

    expect((await login(CTE_CLIENT, "cte-signup@example.com")).status).toBe(
      200,
    );
    // The default client resolves to the main connection, which doesn't own
    // this user.
    expect((await login("clientId", "cte-signup@example.com")).status).toBe(
      403,
    );
  });

  it("answers a signup for an email of another database connection like an existing user", async () => {
    const { env, signup } = await setup();

    await env.data.users.create("tenantId", {
      user_id: "auth0|main-user",
      email: "taken@example.com",
      email_verified: true,
      provider: "auth0",
      connection: MAIN,
      is_social: false,
    });
    await env.data.passwords.create("tenantId", {
      user_id: "auth0|main-user",
      password: await bcryptjs.hash(PASSWORD, 10),
      algorithm: "bcrypt",
    });

    const response = await signup(CTE_CLIENT, "taken@example.com");
    // Same answer as for an existing user in the client's own connection:
    // no 409 that would reveal the account in the other connection.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid sign up");
  });
});
