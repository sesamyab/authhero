import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { parseJWT } from "../../../src/utils/jwt";
import { getTestServer } from "../../helpers/test-server";
import { mintRegistrationToken } from "../../../src/helpers/dcr/mint-token";
import { MANAGEMENT_API_AUDIENCE } from "../../../src/middlewares/authentication";
import type { Bindings } from "../../../src/types";

async function enableDcr(
  env: Bindings,
  extraFlags: Record<string, unknown> = {},
) {
  await env.data.tenants.update("tenantId", {
    flags: {
      enable_dynamic_client_registration: true,
      dcr_require_initial_access_token: false,
      ...extraFlags,
    },
  });
}

async function mintIat(
  env: Bindings,
  opts: {
    sub?: string;
    constraints?: Record<string, unknown>;
    expiresInMs?: number;
    single_use?: boolean;
  } = {},
) {
  const token = await mintRegistrationToken();
  const now = Date.now();
  const expires_at =
    opts.expiresInMs === undefined
      ? new Date(now + 5 * 60 * 1000).toISOString()
      : new Date(now + opts.expiresInMs).toISOString();
  await env.data.clientRegistrationTokens.create("tenantId", {
    id: token.id,
    token_hash: token.token_hash,
    type: "iat",
    sub: opts.sub,
    constraints: opts.constraints,
    single_use: opts.single_use ?? true,
    expires_at,
  });
  return token.token;
}

describe("POST /oidc/register (RFC 7591)", () => {
  it("returns 404 when DCR is not enabled on the tenant", async () => {
    const { oauthApp, env } = await getTestServer();
    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify({
          client_name: "My App",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(404);
  });

  it("rejects unauthenticated request when IAT is explicitly required by tenant flag", async () => {
    const { oauthApp, env } = await getTestServer();
    // Default is open DCR (matches Auth0); tenants must explicitly opt into
    // IAT-gating by setting `dcr_require_initial_access_token: true`.
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify({
          client_name: "My App",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid_token");
  });

  it("registers a client with open DCR (flag off) and returns RFC 7591 response", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify({
          client_name: "My App",
          redirect_uris: ["https://example.com/cb"],
          grant_types: ["authorization_code"],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toBeTypeOf("string");
    expect(body.client_secret).toBeTypeOf("string");
    expect(body.registration_access_token).toBeTypeOf("string");
    expect(body.registration_client_uri).toContain(
      `/oidc/register/${body.client_id}`,
    );
    expect(body.client_name).toBe("My App");
    expect(body.redirect_uris).toEqual(["https://example.com/cb"]);
    expect(body.grant_types).toEqual(["authorization_code"]);

    // Verify callbacks was persisted (AuthHero internal name)
    const stored = await env.data.clients.get("tenantId", body.client_id);
    expect(stored?.callbacks).toEqual(["https://example.com/cb"]);
    expect(stored?.registration_type).toBe("open_dcr");
  });

  it("rejects invalid redirect_uri with 400 invalid_redirect_uri", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify({
          client_name: "Bad App",
          redirect_uris: ["not-a-url"],
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("accepts a valid Initial Access Token and stamps owner_user_id", async () => {
    const { oauthApp, env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const iat = await mintIat(env, { sub: "email|userId" });

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "CMS App",
          redirect_uris: ["https://publisher.com/cb"],
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    const stored = await env.data.clients.get("tenantId", body.client_id);
    expect(stored?.owner_user_id).toBe("email|userId");
    expect(stored?.registration_type).toBe("iat_dcr");
  });

  it("rejects a reused single-use IAT on second call", async () => {
    const { oauthApp, env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const iat = await mintIat(env);

    const first = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "App 1",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(first.status).toBe(201);

    const second = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "App 2",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(second.status).toBe(401);
  });

  it("rejects an expired IAT", async () => {
    const { oauthApp, env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const iat = await mintIat(env, { expiresInMs: -1000 });

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "Expired",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("enforces IAT pre-bound constraints: reject conflicting field", async () => {
    const { oauthApp, env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const iat = await mintIat(env, {
      constraints: { grant_types: ["client_credentials"] },
    });

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "Wrong",
          redirect_uris: ["https://example.com/cb"],
          grant_types: ["authorization_code"],
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("enforces IAT pre-bound constraints: fill in absent field from constraint", async () => {
    const { oauthApp, env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });

    const iat = await mintIat(env, {
      constraints: { grant_types: ["client_credentials"] },
    });

    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${iat}`,
        },
        body: JSON.stringify({
          client_name: "Filled",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.grant_types).toEqual(["client_credentials"]);
  });
});

describe("RFC 7592 client configuration endpoint", () => {
  async function registerClient(oauthApp: any, env: Bindings) {
    await enableDcr(env);
    const response = await oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify({
          client_name: "Self-managed",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    const body = await response.json();
    return {
      client_id: body.client_id,
      registration_access_token: body.registration_access_token,
      client_secret: body.client_secret,
    };
  }

  it("GET returns the client configuration (no client_secret)", async () => {
    const { oauthApp, env } = await getTestServer();
    const { client_id, registration_access_token } = await registerClient(
      oauthApp,
      env,
    );

    const response = await oauthApp.request(
      `/oidc/register/${client_id}`,
      {
        method: "GET",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${registration_access_token}`,
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client_id).toBe(client_id);
    expect(body.client_secret).toBeUndefined();
    expect(body.redirect_uris).toEqual(["https://example.com/cb"]);
  });

  it("GET rejects a RAT bound to a different client_id", async () => {
    const { oauthApp, env } = await getTestServer();
    const first = await registerClient(oauthApp, env);
    const second = await registerClient(oauthApp, env);

    const response = await oauthApp.request(
      `/oidc/register/${second.client_id}`,
      {
        method: "GET",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${first.registration_access_token}`,
        },
      },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("PUT replaces the client configuration", async () => {
    const { oauthApp, env } = await getTestServer();
    const { client_id, registration_access_token } = await registerClient(
      oauthApp,
      env,
    );

    const response = await oauthApp.request(
      `/oidc/register/${client_id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${registration_access_token}`,
        },
        body: JSON.stringify({
          client_name: "Renamed",
          redirect_uris: ["https://example.com/cb", "https://new.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client_name).toBe("Renamed");
    expect(body.redirect_uris).toEqual([
      "https://example.com/cb",
      "https://new.com/cb",
    ]);

    const stored = await env.data.clients.get("tenantId", client_id);
    expect(stored?.name).toBe("Renamed");
  });

  it("PUT rejects a mismatched client_id in the body", async () => {
    const { oauthApp, env } = await getTestServer();
    const { client_id, registration_access_token } = await registerClient(
      oauthApp,
      env,
    );

    const response = await oauthApp.request(
      `/oidc/register/${client_id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${registration_access_token}`,
        },
        body: JSON.stringify({
          client_id: "different-id",
          client_name: "Bad",
          redirect_uris: ["https://example.com/cb"],
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
  });

  it("DELETE soft-deletes the client and invalidates the RAT", async () => {
    const { oauthApp, env } = await getTestServer();
    const { client_id, registration_access_token } = await registerClient(
      oauthApp,
      env,
    );

    const del = await oauthApp.request(
      `/oidc/register/${client_id}`,
      {
        method: "DELETE",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${registration_access_token}`,
        },
      },
      env,
    );
    expect(del.status).toBe(204);

    // Subsequent GET should fail (401)
    const after = await oauthApp.request(
      `/oidc/register/${client_id}`,
      {
        method: "GET",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${registration_access_token}`,
        },
      },
      env,
    );
    expect(after.status).toBe(401);
  });
});

describe("POST /oidc/register — client_grants provisioning", () => {
  async function seedSesamyApi(env: Bindings) {
    await env.data.resourceServers.create("tenantId", {
      name: "Sesamy API",
      identifier: "https://api.sesamy.com",
      scopes: [
        { value: "paywalls:read" },
        { value: "products:read" },
        { value: "admin:write" },
      ],
    });
  }

  async function requireIat(env: Bindings) {
    await env.data.tenants.update("tenantId", {
      flags: {
        enable_dynamic_client_registration: true,
        dcr_require_initial_access_token: true,
      },
    });
  }

  async function register(
    oauthApp: any,
    env: Bindings,
    body: Record<string, unknown>,
    iat?: string,
  ) {
    return oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          ...(iat ? { authorization: `Bearer ${iat}` } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  async function grantsFor(env: Bindings, clientId: string) {
    const { client_grants } = await env.data.clientGrants.list("tenantId", {
      q: `client_id:"${clientId}"`,
    });
    return client_grants;
  }

  async function clientCount(env: Bindings) {
    const { clients } = await env.data.clients.list("tenantId", {
      per_page: 100,
    });
    return clients.length;
  }

  it("creates a client_grants row when audience and scope are pre-bound on the IAT", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);

    const iat = await mintIat(env, {
      sub: "email|userId",
      constraints: {
        audience: "https://api.sesamy.com",
        scope: "paywalls:read products:read",
        grant_types: ["client_credentials"],
      },
    });

    const response = await register(
      oauthApp,
      env,
      {
        client_name: "Publisher Site",
        token_endpoint_auth_method: "client_secret_basic",
      },
      iat,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.scope).toBe("paywalls:read products:read");

    const client_grants = await grantsFor(env, body.client_id);
    expect(client_grants).toHaveLength(1);
    expect(client_grants[0].audience).toBe("https://api.sesamy.com");
    expect(client_grants[0].scope).toEqual(["paywalls:read", "products:read"]);
  });

  it("accepts a request that repeats the pinned audience and scope", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://api.sesamy.com",
        scope: "paywalls:read",
        grant_types: ["client_credentials"],
      },
    });

    const response = await register(
      oauthApp,
      env,
      {
        client_name: "Repeats pins",
        grant_types: ["client_credentials"],
        audience: "https://api.sesamy.com",
        scope: "paywalls:read",
      },
      iat,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    const client_grants = await grantsFor(env, body.client_id);
    expect(client_grants).toHaveLength(1);
    expect(client_grants[0].scope).toEqual(["paywalls:read"]);
  });

  it("rejects audience and scope in the request body on open registration", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);
    await seedSesamyApi(env);
    const before = await clientCount(env);

    const response = await register(oauthApp, env, {
      client_name: "Open M2M",
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "client_secret_basic",
      audience: "https://api.sesamy.com",
      scope: "paywalls:read",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toMatch(
      /can only be set by an Initial Access Token constraint/,
    );
    expect(await clientCount(env)).toBe(before);
  });

  it("rejects an audience in the request body when the IAT does not pin one", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);
    const before = await clientCount(env);

    const iat = await mintIat(env, {
      constraints: { grant_types: ["client_credentials"] },
    });
    const response = await register(
      oauthApp,
      env,
      {
        client_name: "Picks its own API",
        grant_types: ["client_credentials"],
        audience: "https://api.sesamy.com",
      },
      iat,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/"audience"/);
    expect(await clientCount(env)).toBe(before);
  });

  it("rejects scope in the request body when the IAT pins only the audience", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);
    const before = await clientCount(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://api.sesamy.com",
        grant_types: ["client_credentials"],
      },
    });
    const response = await register(
      oauthApp,
      env,
      {
        client_name: "Widens its scopes",
        grant_types: ["client_credentials"],
        scope: "paywalls:read admin:write",
      },
      iat,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/"scope"/);
    expect(await clientCount(env)).toBe(before);
  });

  it("refuses the Management API audience even when pinned on the IAT", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    const before = await clientCount(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: MANAGEMENT_API_AUDIENCE,
        scope: "read:users",
        grant_types: ["client_credentials"],
      },
    });
    const response = await register(
      oauthApp,
      env,
      { client_name: "Management client" },
      iat,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toMatch(
      /cannot be granted through Dynamic Client Registration/,
    );
    expect(await clientCount(env)).toBe(before);
  });

  it("refuses an additional management audience configured on the deployment", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    const legacyAudience = "https://tenantId.token.example.com/v2/api/";
    await env.data.resourceServers.create("tenantId", {
      name: "Legacy management API",
      identifier: legacyAudience,
      scopes: [{ value: "read:users" }],
    });
    env.additionalManagementAudiences = ({ tenant_id }) => [
      `https://${tenant_id}.token.example.com/v2/api/`,
    ];

    const iat = await mintIat(env, {
      constraints: {
        audience: legacyAudience,
        grant_types: ["client_credentials"],
      },
    });
    const response = await register(
      oauthApp,
      env,
      { client_name: "Legacy management client" },
      iat,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(
      /cannot be granted through Dynamic Client Registration/,
    );
  });

  it("rejects scope without audience", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);
    await seedSesamyApi(env);

    const response = await register(oauthApp, env, {
      client_name: "Bad",
      grant_types: ["client_credentials"],
      scope: "paywalls:read",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects an unknown pinned audience", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://nope.example.com",
        grant_types: ["client_credentials"],
      },
    });
    const response = await register(oauthApp, env, { client_name: "Bad" }, iat);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toMatch(/Unknown audience/);
  });

  it("rejects a pinned scope not defined on the resource server", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://api.sesamy.com",
        scope: "paywalls:read root:everything",
        grant_types: ["client_credentials"],
      },
    });
    const response = await register(oauthApp, env, { client_name: "Bad" }, iat);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_scope");
  });

  it("does not create a grant when audience is omitted", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);

    const response = await register(oauthApp, env, {
      client_name: "No grant",
      redirect_uris: ["https://example.com/cb"],
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(await grantsFor(env, body.client_id)).toHaveLength(0);
  });

  it("DELETE removes the client's grants alongside the soft-delete", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://api.sesamy.com",
        scope: "paywalls:read",
        grant_types: ["client_credentials"],
      },
    });
    const reg = await register(
      oauthApp,
      env,
      {
        client_name: "Will be deleted",
        token_endpoint_auth_method: "client_secret_basic",
      },
      iat,
    );
    expect(reg.status).toBe(201);
    const created = await reg.json();
    expect(await grantsFor(env, created.client_id)).toHaveLength(1);

    const del = await oauthApp.request(
      `/oidc/register/${created.client_id}`,
      {
        method: "DELETE",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${created.registration_access_token}`,
        },
      },
      env,
    );
    expect(del.status).toBe(204);
    expect(await grantsFor(env, created.client_id)).toHaveLength(0);
  });

  it("end-to-end: registered client can mint an access token with the pinned scopes via client_credentials", async () => {
    const { oauthApp, env } = await getTestServer();
    await requireIat(env);
    await seedSesamyApi(env);

    const iat = await mintIat(env, {
      constraints: {
        audience: "https://api.sesamy.com",
        scope: "paywalls:read products:read",
        grant_types: ["client_credentials"],
      },
    });
    const reg = await register(
      oauthApp,
      env,
      {
        client_name: "M2M App",
        token_endpoint_auth_method: "client_secret_basic",
      },
      iat,
    );
    expect(reg.status).toBe(201);
    const { client_id, client_secret } = await reg.json();

    const tokenResp = await oauthApp.request(
      "/oauth/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "tenant-id": "tenantId",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id,
          client_secret,
          audience: "https://api.sesamy.com",
        }).toString(),
      },
      env,
    );
    expect(tokenResp.status).toBe(200);
    const tokenBody = await tokenResp.json();
    const accessToken = parseJWT(tokenBody.access_token as string);
    const scopes = ((accessToken?.payload as { scope?: string })?.scope ?? "")
      .split(" ")
      .filter(Boolean);
    expect(scopes).toContain("paywalls:read");
    expect(scopes).toContain("products:read");
  });
});

describe("Discovery registration_endpoint gating", () => {
  it("omits registration_endpoint when DCR flag is off", async () => {
    const { oauthApp, env } = await getTestServer();
    const client = testClient(oauthApp, env);

    const response = await client[".well-known"]["openid-configuration"].$get(
      { param: {} },
      { headers: { "tenant-id": "tenantId" } },
    );
    const body = await response.json();
    expect(body.registration_endpoint).toBeUndefined();
  });

  it("includes registration_endpoint when DCR flag is on", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const client = testClient(oauthApp, env);

    const response = await client[".well-known"]["openid-configuration"].$get(
      { param: {} },
      { headers: { "tenant-id": "tenantId" } },
    );
    const body = await response.json();
    expect(body.registration_endpoint).toBe(
      "http://localhost:3000/oidc/register",
    );
  });
});

describe("omitted grant_types is validated as its authorization_code default", () => {
  async function post(oauthApp: any, env: Bindings, body: object) {
    return oauthApp.request(
      "/oidc/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("requires redirect_uris when grant_types is omitted", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const response = await post(oauthApp, env, { client_name: "No URIs" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_redirect_uri");
  });

  it("applies the tenant grant-type allowlist to the default", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env, { dcr_allowed_grant_types: ["client_credentials"] });
    const response = await post(oauthApp, env, {
      client_name: "Code flow by default",
      redirect_uris: ["https://app.example.com/cb"],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(
      /authorization_code/,
    );
  });

  it("applies the allowlist to the default on PUT", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableDcr(env, { dcr_allowed_grant_types: ["client_credentials"] });
    const created = await (
      await post(oauthApp, env, {
        client_name: "M2M",
        grant_types: ["client_credentials"],
      })
    ).json();

    const response = await oauthApp.request(
      `/oidc/register/${created.client_id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "tenant-id": "tenantId",
          authorization: `Bearer ${created.registration_access_token}`,
        },
        body: JSON.stringify({ client_name: "M2M" }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const client = await env.data.clients.get("tenantId", created.client_id);
    expect(client?.grant_types).toEqual(["client_credentials"]);
  });
});
