import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

describe("username/password provider migration", () => {
  it("signs up new users under the auth0 provider for migrated tenants", async () => {
    const { oauthApp, env } = await getTestServer({
      mockEmail: true,
      usernamePasswordProvider: () => "auth0",
    });
    const client = testClient(oauthApp, env);

    const response = await client.dbconnections.signup.$post(
      {
        json: {
          email: "newcomer@example.com",
          password: "fG%D0MV4bjb%xI",
          connection: Strategy.USERNAME_PASSWORD,
          client_id: "clientId",
        },
      },
      { headers: { "tenant-id": "tenantId" } },
    );
    expect(response.status).toBe(200);

    const { users } = await env.data.users.list("tenantId", {
      page: 0,
      per_page: 10,
      include_totals: false,
      q: "email:newcomer@example.com",
    });
    expect(users.length).toBe(1);
    expect(users[0]!.provider).toBe("auth0");
    expect(users[0]!.user_id.startsWith("auth0|")).toBe(true);
  });

  it("logs in a legacy auth2 user even after the tenant is configured for auth0", async () => {
    const { oauthApp, env } = await getTestServer({
      mockEmail: true,
      usernamePasswordProvider: () => "auth0",
    });
    const oauthClient = testClient(oauthApp, env);

    // Pre-existing auth2 row (created before the tenant was migrated)
    await env.data.users.create("tenantId", {
      user_id: "auth2|legacy-user",
      email: "legacy@example.com",
      email_verified: true,
      connection: Strategy.USERNAME_PASSWORD,
      provider: "auth2",
      is_social: false,
    });
    await env.data.passwords.create("tenantId", {
      user_id: "auth2|legacy-user",
      password: await bcryptjs.hash("CorrectPassword123!", 1),
      algorithm: "bcrypt",
    });

    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: "clientId",
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: Strategy.USERNAME_PASSWORD,
        password: "CorrectPassword123!",
        username: "legacy@example.com",
      },
    });
    expect(response.status).toBe(200);
  });
});
