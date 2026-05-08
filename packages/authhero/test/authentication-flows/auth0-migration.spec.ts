import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { USERNAME_PASSWORD_PROVIDER } from "../../src/constants";

const TENANT_ID = "tenantId";
const CLIENT_ID = "clientId";
const REALM = Strategy.USERNAME_PASSWORD;
const UPSTREAM_DOMAIN = "https://upstream.example.auth0.com";
const UPSTREAM_TOKEN_ENDPOINT = `${UPSTREAM_DOMAIN}/oauth/token`;
const UPSTREAM_USERINFO_ENDPOINT = `${UPSTREAM_DOMAIN}/userinfo`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface MigrationServerOptions {
  importModeOnDb?: boolean;
  importModeOnAuth0?: boolean;
  withAuth0Source?: boolean;
}

async function makeMigrationServer(options: MigrationServerOptions = {}) {
  const {
    importModeOnDb = true,
    importModeOnAuth0 = true,
    withAuth0Source = true,
  } = options;
  const server = await getTestServer();
  const { env } = server;

  // The default fixture creates the DB connection with the wrong strategy
  // value ("auth2" — the legacy provider value). Force-update it to the real
  // strategy + import_mode so the migration code path is exercised.
  await env.data.connections.update(
    TENANT_ID,
    "Username-Password-Authentication",
    {
      strategy: Strategy.USERNAME_PASSWORD,
      options: { import_mode: importModeOnDb },
    },
  );

  if (withAuth0Source) {
    await env.data.connections.create(TENANT_ID, {
      id: "auth0-source",
      name: "auth0-source",
      strategy: Strategy.AUTH0,
      options: {
        client_id: "upstream-cid",
        client_secret: "upstream-csecret",
        token_endpoint: UPSTREAM_TOKEN_ENDPOINT,
        userinfo_endpoint: UPSTREAM_USERINFO_ENDPOINT,
        import_mode: importModeOnAuth0,
      },
    });
  }

  return server;
}

describe("auth0 migration: password fallback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a local user + password on first login when upstream accepts", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "upstream-at",
          id_token: "upstream-it",
          token_type: "Bearer",
          expires_in: 86400,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sub: "auth0|migrated-1",
          email: "migrated@example.com",
          email_verified: true,
          name: "Migrated User",
          given_name: "Migrated",
          family_name: "User",
        }),
      );

    const { oauthApp, env } = await makeMigrationServer();
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "migrated@example.com",
        password: "UpstreamPassword!",
      },
    });

    expect(response.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe(UPSTREAM_TOKEN_ENDPOINT);
    const tokenBody = new URLSearchParams(tokenInit.body);
    expect(tokenBody.get("grant_type")).toBe(
      "http://auth0.com/oauth/grant-type/password-realm",
    );
    expect(tokenBody.get("realm")).toBe(REALM);
    expect(tokenBody.get("username")).toBe("migrated@example.com");
    expect(tokenBody.get("client_id")).toBe("upstream-cid");

    const [userinfoUrl, userinfoInit] = fetchSpy.mock.calls[1];
    expect(userinfoUrl).toBe(UPSTREAM_USERINFO_ENDPOINT);
    expect(userinfoInit.headers.authorization).toBe("Bearer upstream-at");

    const { users } = await env.data.users.list(TENANT_ID, {
      page: 0,
      per_page: 10,
      include_totals: false,
      q: "email:migrated@example.com",
    });
    const migratedUser = users.find(
      (u) => u.connection === Strategy.USERNAME_PASSWORD,
    );
    expect(migratedUser).toBeDefined();
    expect(migratedUser?.email).toBe("migrated@example.com");
    expect(migratedUser?.given_name).toBe("Migrated");

    const passwordRow = await env.data.passwords.get(
      TENANT_ID,
      migratedUser!.user_id,
    );
    expect(passwordRow).toBeDefined();
    expect(
      await bcryptjs.compare("UpstreamPassword!", passwordRow!.password),
    ).toBe(true);
  });

  it("serves the second login entirely locally (no upstream calls)", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "upstream-at",
          token_type: "Bearer",
          expires_in: 86400,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sub: "auth0|migrated-2",
          email: "second@example.com",
          email_verified: true,
        }),
      );

    const { oauthApp, env } = await makeMigrationServer();
    const oauthClient = testClient(oauthApp, env);

    const first = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "second@example.com",
        password: "Pwd1!",
      },
    });
    expect(first.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const second = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "second@example.com",
        password: "Pwd1!",
      },
    });
    expect(second.status).toBe(200);
    // Still 2 — no further upstream call on the second login.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects with INVALID_PASSWORD when upstream rejects credentials", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(403, {
        error: "invalid_grant",
        error_description: "Wrong email or password.",
      }),
    );

    const { oauthApp, env } = await makeMigrationServer();
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "nobody@example.com",
        password: "wrong",
      },
    });

    expect(response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const { users } = await env.data.users.list(TENANT_ID, {
      page: 0,
      per_page: 10,
      include_totals: false,
      q: "email:nobody@example.com",
    });
    expect(users).toHaveLength(0);
  });

  it("does NOT call upstream when DB connection has import_mode=false", async () => {
    const { oauthApp, env } = await makeMigrationServer({
      importModeOnDb: false,
    });
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "nobody@example.com",
        password: "anything",
      },
    });

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT call upstream when no auth0-source connection exists", async () => {
    const { oauthApp, env } = await makeMigrationServer({
      withAuth0Source: false,
    });
    const oauthClient = testClient(oauthApp, env);

    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "nobody@example.com",
        password: "anything",
      },
    });

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("migrates an existing local user (created without a password) on first login", async () => {
    const { oauthApp, env } = await makeMigrationServer();

    await env.data.users.create(TENANT_ID, {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|preexisting`,
      email: "preexisting@example.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      is_social: false,
    });

    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "upstream-at",
          token_type: "Bearer",
          expires_in: 86400,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sub: "auth0|preexisting",
          email: "preexisting@example.com",
          email_verified: true,
        }),
      );

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.co.authenticate.$post({
      json: {
        client_id: CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        realm: REALM,
        username: "preexisting@example.com",
        password: "Pwd1!",
      },
    });

    expect(response.status).toBe(200);

    const passwordRow = await env.data.passwords.get(
      TENANT_ID,
      `${USERNAME_PASSWORD_PROVIDER}|preexisting`,
    );
    expect(passwordRow).toBeDefined();
    expect(
      await bcryptjs.compare("Pwd1!", passwordRow!.password),
    ).toBe(true);
  });
});
