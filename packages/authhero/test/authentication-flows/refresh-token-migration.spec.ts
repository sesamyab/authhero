import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import { getTestServer } from "../helpers/test-server";
import { REFRESH_TOKEN_PREFIX } from "../../src/utils/refresh-token-format";

const TENANT_ID = "tenantId";
const CLIENT_ID = "clientId";
const UPSTREAM_DOMAIN = "https://upstream.example.auth0.com";
const UPSTREAM_TOKEN_ENDPOINT = `${UPSTREAM_DOMAIN}/oauth/token`;
const UPSTREAM_USERINFO_ENDPOINT = `${UPSTREAM_DOMAIN}/userinfo`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

async function seedMigrationSource(
  env: Awaited<ReturnType<typeof getTestServer>>["env"],
  overrides: Partial<{
    enabled: boolean;
    connection: string;
    domain: string;
  }> = {},
) {
  if (!env.data.migrationSources) {
    throw new Error("migrationSources adapter not available in test fixture");
  }
  return env.data.migrationSources.create(TENANT_ID, {
    name: "Upstream Auth0",
    provider: "auth0",
    connection: overrides.connection ?? "auth0",
    enabled: overrides.enabled ?? true,
    credentials: {
      domain: overrides.domain ?? UPSTREAM_DOMAIN,
      client_id: "upstream-cid",
      client_secret: "upstream-csecret",
    },
  });
}

describe("refresh-token migration: lazy re-mint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lazily creates a local user and mints fresh authhero tokens when upstream accepts the refresh token", async () => {
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
          sub: "auth0|migrated-rt-1",
          email: "rt-migrated@example.com",
          email_verified: true,
          name: "RT Migrated",
        }),
      );

    const { oauthApp, env } = await getTestServer();
    await seedMigrationSource(env);

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "legacy-auth0-refresh-token",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenResponse;
    expect(body.access_token).toBeTypeOf("string");
    expect(body.refresh_token).toBeTypeOf("string");
    expect(body.refresh_token!.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);

    // Two upstream calls: /oauth/token then /userinfo.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe(UPSTREAM_TOKEN_ENDPOINT);
    const tokenBody = new URLSearchParams(tokenInit.body);
    expect(tokenBody.get("grant_type")).toBe("refresh_token");
    expect(tokenBody.get("refresh_token")).toBe("legacy-auth0-refresh-token");
    expect(tokenBody.get("client_id")).toBe("upstream-cid");

    const [userinfoUrl, userinfoInit] = fetchSpy.mock.calls[1];
    expect(userinfoUrl).toBe(UPSTREAM_USERINFO_ENDPOINT);
    expect(userinfoInit.headers.authorization).toBe("Bearer upstream-at");

    const { users } = await env.data.users.list(TENANT_ID, {
      page: 0,
      per_page: 10,
      include_totals: false,
      q: "email:rt-migrated@example.com",
    });
    expect(users).toHaveLength(1);
    expect(users[0].connection).toBe("auth0");
    expect(users[0].provider).toBe("auth0");
  });

  it("subsequent calls with the freshly minted authhero refresh token bypass upstream", async () => {
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
          sub: "auth0|migrated-rt-2",
          email: "rt-second@example.com",
          email_verified: true,
        }),
      );

    const { oauthApp, env } = await getTestServer();
    await seedMigrationSource(env);

    const oauthClient = testClient(oauthApp, env);
    const first = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "legacy-rt",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TokenResponse;
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const second = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: firstBody.refresh_token,
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );
    expect(second.status).toBe(200);
    // Still 2 — second exchange resolved entirely from the local DB.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns invalid_grant when upstream rejects the refresh token", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(401, {
        error: "invalid_grant",
        error_description: "Unknown or invalid refresh token.",
      }),
    );

    const { oauthApp, env } = await getTestServer();
    await seedMigrationSource(env);

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "not-a-real-token",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toBe("invalid_grant");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_grant when no migration source is configured", async () => {
    const { oauthApp, env } = await getTestServer();

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "anything",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips disabled migration sources", async () => {
    const { oauthApp, env } = await getTestServer();
    await seedMigrationSource(env, { enabled: false });

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "anything",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to the next migration source when the first rejects", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: "invalid_grant",
          error_description: "Wrong tenant.",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "upstream-at",
          token_type: "Bearer",
          expires_in: 86400,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sub: "auth0|fallthrough",
          email: "fallthrough@example.com",
          email_verified: true,
        }),
      );

    const { oauthApp, env } = await getTestServer();
    await seedMigrationSource(env, {
      connection: "auth0",
      domain: "https://upstream-a.example.auth0.com",
    });
    await seedMigrationSource(env, {
      connection: "auth0",
      domain: UPSTREAM_DOMAIN,
    });

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.oauth.token.$post(
      // @ts-expect-error - testClient type requires both form and json
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: "rt-from-source-b",
          client_id: CLIENT_ID,
        },
      },
      { headers: { "tenant-id": TENANT_ID } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenResponse;
    expect(body.refresh_token!.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    // 3 calls: source A /oauth/token (rejected), source B /oauth/token, source B /userinfo.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
