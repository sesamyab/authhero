import { describe, it, expect } from "vitest";
import { getAdminToken } from "../helpers/token";
import { getTestServer } from "../helpers/test-server";

// #1705: creating and updating users within a named database connection.
// The test tenant has the "Username-Password-Authentication" database
// connection; most tests add a second one, as a token exchange profile uses.

const MAIN = "Username-Password-Authentication";
const CTE = "cte-store";
const CTE_ID = "con_cte";

const USER_EXISTS_BODY = {
  statusCode: 409,
  error: "Conflict",
  message: "The user already exists.",
  errorCode: "auth0_idp_error",
};

async function setup({ secondConnection = true } = {}) {
  const { managementApp, env } = await getTestServer();
  const token = await getAdminToken();
  if (secondConnection) {
    await env.data.connections.create("tenantId", {
      id: CTE_ID,
      name: CTE,
      strategy: "auth0",
      options: {},
    });
  }

  const request = (method: string, path: string, body?: unknown) =>
    managementApp.request(
      path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  return { env, request };
}

describe("POST /api/v2/users in a named database connection", () => {
  it("stores the connection's name when it is named", async () => {
    const { request } = await setup();

    const response = await request("POST", "/users", {
      connection: CTE,
      email: "named@example.com",
      password: "Password123!",
    });

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.connection).toBe(CTE);
    expect(created.user_id).toMatch(/^auth0\|/);
    expect(created.identities[0]).toMatchObject({
      connection: CTE,
      provider: "auth0",
    });
  });

  it("stores the connection's name when the caller passes its id", async () => {
    const { request, env } = await setup();

    const response = await request("POST", "/users", {
      connection: CTE_ID,
      email: "by-id@example.com",
    });

    expect(response.status).toBe(201);
    const created = await response.json();
    const stored = await env.data.users.get("tenantId", created.user_id);
    expect(stored?.connection).toBe(CTE);
  });

  it("returns Auth0's 409 for an email already in the connection", async () => {
    const { request } = await setup();
    const body = { connection: CTE, email: "dup@example.com" };

    expect((await request("POST", "/users", body)).status).toBe(201);

    const duplicate = await request("POST", "/users", body);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual(USER_EXISTS_BODY);
  });

  it("returns Auth0's 409 for a username already in the connection", async () => {
    const { request } = await setup();

    expect(
      (
        await request("POST", "/users", {
          connection: CTE,
          email: "first@example.com",
          username: "takenname",
        })
      ).status,
    ).toBe(201);

    const duplicate = await request("POST", "/users", {
      connection: CTE,
      email: "second@example.com",
      username: "takenname",
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual(USER_EXISTS_BODY);
  });

  it("still rejects an email used in another database connection (until #1704)", async () => {
    // The users table is unique per (email, provider), and both connections
    // use the auth0 provider. #1704 moves that index to connections.
    const { request } = await setup();

    expect(
      (
        await request("POST", "/users", {
          connection: MAIN,
          email: "shared@example.com",
        })
      ).status,
    ).toBe(201);

    const other = await request("POST", "/users", {
      connection: CTE,
      email: "shared@example.com",
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual(USER_EXISTS_BODY);
  });
});

describe("PATCH /api/v2/users within the user's own connection", () => {
  it("returns 409 instead of 500 for a username taken in the same connection", async () => {
    // Single database connection: the plain tenant.
    const { request } = await setup({ secondConnection: false });

    await request("POST", "/users", {
      connection: MAIN,
      email: "holder@example.com",
      username: "holder",
    });
    const created = await (
      await request("POST", "/users", {
        connection: MAIN,
        email: "renamer@example.com",
        username: "renamer",
      })
    ).json();

    const patch = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { username: "holder" },
    );
    expect(patch.status).toBe(409);
    expect(await patch.json()).toEqual(USER_EXISTS_BODY);

    // A free username still goes through.
    const ok = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { username: "freename" },
    );
    expect(ok.status).toBe(200);
  });

  it("treats a legacy row with no attributable connection as the same connection", async () => {
    const { request, env } = await setup();

    // An auth2 row whose connection is a provider literal, not a connection
    // name: login lookups in every database connection see it.
    await env.data.users.create("tenantId", {
      user_id: "auth2|legacy",
      email: "legacy@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "auth2",
      is_social: false,
    });
    const created = await (
      await request("POST", "/users", {
        connection: CTE,
        email: "cte-user@example.com",
      })
    ).json();

    const patch = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { email: "legacy@example.com" },
    );
    expect(patch.status).toBe(409);
  });

  it("allows an email held by a different-provider user of another database connection", async () => {
    const { request, env } = await setup();

    // An auth2 user in the main connection. The auth0 user in the second
    // connection may take the same address: the rows don't share a provider
    // (so the unique index allows it) or a connection.
    await env.data.users.create("tenantId", {
      user_id: "auth2|main",
      email: "main-user@example.com",
      email_verified: true,
      provider: "auth2",
      connection: MAIN,
      is_social: false,
    });
    const created = await (
      await request("POST", "/users", {
        connection: CTE,
        email: "cte-user@example.com",
      })
    ).json();

    const patch = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { email: "main-user@example.com" },
    );
    expect(patch.status).toBe(200);
  });

  it("sets a password through a named database connection", async () => {
    const { request, env } = await setup();
    const created = await (
      await request("POST", "/users", {
        connection: CTE,
        email: "pw@example.com",
      })
    ).json();

    const patch = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { connection: CTE, password: "NewPassword123!" },
    );
    expect(patch.status).toBe(200);

    const password = await env.data.passwords.get("tenantId", created.user_id);
    expect(password).toBeTruthy();
  });

  it("does not target a database identity of another connection", async () => {
    const { request } = await setup();
    const created = await (
      await request("POST", "/users", {
        connection: CTE,
        email: "only-cte@example.com",
      })
    ).json();

    const patch = await request(
      "PATCH",
      `/users/${encodeURIComponent(created.user_id)}`,
      { connection: MAIN, name: "Wrong connection" },
    );
    expect(patch.status).toBe(404);
  });
});

describe("GET /api/v2/users-by-email across database connections", () => {
  it("returns the matches of every connection", async () => {
    const { request, env } = await setup();

    await env.data.users.create("tenantId", {
      user_id: "auth2|main-both",
      email: "both@example.com",
      email_verified: true,
      provider: "auth2",
      connection: MAIN,
      is_social: false,
    });
    await env.data.users.create("tenantId", {
      user_id: "auth0|cte-both",
      email: "both@example.com",
      email_verified: true,
      provider: "auth0",
      connection: CTE,
      is_social: false,
    });

    const response = await request(
      "GET",
      `/users-by-email?email=${encodeURIComponent("both@example.com")}`,
    );
    expect(response.status).toBe(200);
    const users: { user_id: string }[] = await response.json();
    expect(users.map((u) => u.user_id).sort()).toEqual([
      "auth0|cte-both",
      "auth2|main-both",
    ]);
  });
});
