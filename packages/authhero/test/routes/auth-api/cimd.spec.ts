import { describe, it, expect, vi, afterEach } from "vitest";
import { testClient } from "hono/testing";
import { openIDConfigurationSchema } from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import {
  cimdTenantHint,
  isCimdClientId,
  resolveCimdClient,
  cimdDocumentSchema,
} from "../../../src/helpers/cimd";
import { getEnrichedClient } from "../../../src/helpers/client";
import { SsrfFetchOptions } from "../../../src/utils/ssrf-fetch";

const CIMD_URL = "https://rp.example.com/cimd.json";

const ALLOW_PRIVATE: SsrfFetchOptions = {
  allowPrivateHosts: true,
  allowedSchemes: ["http:", "https:"],
};

function validDocument(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CIMD_URL,
    client_name: "Example MCP Client",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["https://rp.example.com/callback"],
    application_type: "web",
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

async function enableCimd(
  env: Awaited<ReturnType<typeof getTestServer>>["env"],
) {
  await env.data.tenants.update("tenantId", {
    flags: { client_id_metadata_document_registration: true },
  });
}

describe("isCimdClientId", () => {
  it("recognizes http(s) URLs and rejects opaque ids", () => {
    expect(isCimdClientId("https://rp.example.com/cimd.json")).toBe(true);
    expect(isCimdClientId("http://localhost:8080/cimd.json")).toBe(true);
    expect(isCimdClientId("clientId")).toBe(false);
    expect(isCimdClientId("not a url")).toBe(false);
  });
});

describe("cimdTenantHint", () => {
  it("passes the request tenant only for CIMD client_ids", () => {
    expect(cimdTenantHint(CIMD_URL, "tenantId")).toBe("tenantId");
    expect(cimdTenantHint(CIMD_URL, undefined)).toBeUndefined();
    expect(cimdTenantHint(CIMD_URL, "")).toBeUndefined();
    expect(cimdTenantHint("clientId", "tenantId")).toBeUndefined();
  });
});

describe("cimdDocumentSchema", () => {
  it("requires an authorization_code or refresh_token grant", () => {
    expect(
      cimdDocumentSchema.safeParse(
        validDocument({ grant_types: ["client_credentials"] }),
      ).success,
    ).toBe(false);
  });

  it("rejects unsupported token_endpoint_auth_method", () => {
    expect(
      cimdDocumentSchema.safeParse(
        validDocument({ token_endpoint_auth_method: "client_secret_basic" }),
      ).success,
    ).toBe(false);
  });
});

describe("resolveCimdClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches, validates, and maps a document into a public client", async () => {
    mockFetchJson(validDocument());

    const client = await resolveCimdClient(CIMD_URL, ALLOW_PRIVATE);

    expect(client.client_id).toBe(CIMD_URL);
    expect(client.name).toBe("Example MCP Client");
    expect(client.app_type).toBe("regular_web");
    expect(client.is_first_party).toBe(false);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.client_secret).toBeUndefined();
    expect(client.callbacks).toEqual(["https://rp.example.com/callback"]);
    expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("maps native application_type and jwks_uri", async () => {
    mockFetchJson(
      validDocument({
        application_type: "native",
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: "https://rp.example.com/jwks.json",
      }),
    );

    const client = await resolveCimdClient(CIMD_URL, ALLOW_PRIVATE);

    expect(client.app_type).toBe("native");
    expect(client.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(client.client_metadata?.jwks_uri).toBe(
      "https://rp.example.com/jwks.json",
    );
  });

  it("rejects when the document client_id does not match the URL", async () => {
    mockFetchJson(validDocument({ client_id: "https://evil.example/cimd" }));
    await expect(resolveCimdClient(CIMD_URL, ALLOW_PRIVATE)).rejects.toThrow(
      /does not match/,
    );
  });

  it("rejects private_key_jwt without a jwks_uri", async () => {
    mockFetchJson(
      validDocument({ token_endpoint_auth_method: "private_key_jwt" }),
    );
    await expect(resolveCimdClient(CIMD_URL, ALLOW_PRIVATE)).rejects.toThrow(
      /jwks_uri is required/,
    );
  });

  it("rejects a non-200 response", async () => {
    mockFetchJson("not found", 404);
    await expect(resolveCimdClient(CIMD_URL, ALLOW_PRIVATE)).rejects.toThrow(
      /status 404/,
    );
  });

  it("rejects a document larger than the size cap", async () => {
    mockFetchJson(validDocument({ client_name: "x".repeat(6 * 1024) }));
    await expect(resolveCimdClient(CIMD_URL, ALLOW_PRIVATE)).rejects.toThrow(
      /Invalid CIMD/,
    );
  });

  it("rejects http URLs when private hosts are not allowed", async () => {
    mockFetchJson(validDocument());
    await expect(
      resolveCimdClient("http://rp.example.com/cimd.json"),
    ).rejects.toThrow(/Invalid CIMD/);
  });

  it("rejects a URL without a path", async () => {
    await expect(
      resolveCimdClient("https://rp.example.com", ALLOW_PRIVATE),
    ).rejects.toThrow(/must contain a path/);
  });

  it("rejects a client_id longer than 120 bytes", async () => {
    const longUrl = `https://rp.example.com/${"a".repeat(120)}`;
    await expect(resolveCimdClient(longUrl, ALLOW_PRIVATE)).rejects.toThrow(
      /exceeds 120 bytes/,
    );
  });

  it("rejects URLs with a query string", async () => {
    await expect(
      resolveCimdClient("https://rp.example.com/cimd?x=1", ALLOW_PRIVATE),
    ).rejects.toThrow(/query string/);
  });
});

describe("authorization server metadata advertises CIMD", () => {
  it("advertises the flag as false when the tenant setting is off", async () => {
    const { oauthApp, env } = await getTestServer();
    const client = testClient(oauthApp, env);

    const response = await client[".well-known"]["openid-configuration"].$get(
      { param: {} },
      { headers: { "tenant-id": "tenantId" } },
    );

    const body = openIDConfigurationSchema.parse(await response.json());
    expect(body.client_id_metadata_document_supported).toBe(false);
  });

  it("advertises the flag on both metadata endpoints when enabled", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    const client = testClient(oauthApp, env);

    const oidc = await client[".well-known"]["openid-configuration"].$get(
      { param: {} },
      { headers: { "tenant-id": "tenantId" } },
    );
    const oidcBody = openIDConfigurationSchema.parse(await oidc.json());
    expect(oidcBody.client_id_metadata_document_supported).toBe(true);

    const as = await client[".well-known"]["oauth-authorization-server"].$get(
      { param: {} },
      { headers: { "tenant-id": "tenantId" } },
    );
    expect(as.status).toBe(200);
    const asBody = openIDConfigurationSchema.parse(await as.json());
    expect(asBody.client_id_metadata_document_supported).toBe(true);
    expect(asBody.issuer).toBe("http://localhost:3000/");
  });
});

describe("/authorize with a CIMD client_id", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the CIMD client and redirects to universal login", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    const fetchSpy = mockFetchJson(validDocument());

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "xyz",
      },
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(response.status).not.toBe(400);
    expect([200, 302]).toContain(response.status);
  });

  it("returns 403 when the tenant flag is disabled", async () => {
    const { oauthApp, env } = await getTestServer();
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      },
    });

    expect(response.status).toBe(403);
  });

  it("rejects a code flow without PKCE S256", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/PKCE/);
  });

  it("rejects when the document client_id does not match the URL", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument({ client_id: "https://evil.example/cimd" }));

    const oauthClient = testClient(oauthApp, env);
    const response = await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not match/);
  });

  it("upserts a stub client row so refresh_token FK is satisfied", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    expect(await env.data.clients.get("tenantId", CIMD_URL)).toBeNull();

    const oauthClient = testClient(oauthApp, env);
    await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "xyz",
      },
    });

    const stub = await env.data.clients.get("tenantId", CIMD_URL);
    expect(stub).not.toBeNull();
    expect(stub?.name).toBe("Example MCP Client");
    expect(stub?.client_metadata?.cimd).toBe("true");
  });
});

describe("getEnrichedClient recovers the CIMD tenant on state-keyed routes", () => {
  afterEach(() => vi.restoreAllMocks());

  // Regression: after a social login (e.g. Google), the browser returns to the
  // /callback (and then /authorize/resume) route. Those routes resolve their
  // tenant from the login-session state, not the host, so ctx.var.tenant_id is
  // empty and connectionCallback/resumeLoginSession call getEnrichedClient with
  // no tenant argument. For a CIMD client this used to throw
  // "tenant_id is required to resolve a CIMD client", dead-ending the login at
  // /u/login/identifier?error=access_denied. It must instead recover the tenant
  // from the stub row upserted on the first /authorize.
  it("resolves a CIMD client without a tenant hint once the stub exists", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    // First /authorize upserts the stub row under the tenant, exactly as the
    // real flow does before the browser is redirected out to the IdP.
    const oauthClient = testClient(oauthApp, env);
    await oauthClient.authorize.$get({
      query: {
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "xyz",
      },
    });

    // Mirror connectionCallback/resumeLoginSession: no tenant, no fetch opts.
    const client = await getEnrichedClient(env, CIMD_URL);

    expect(client.client_id).toBe(CIMD_URL);
    expect(client.tenant.id).toBe("tenantId");
    expect(client.name).toBe("Example MCP Client");
  });

  it("still throws when no stub exists and no tenant is supplied", async () => {
    const { env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    await expect(getEnrichedClient(env, CIMD_URL)).rejects.toThrow(
      /tenant_id is required/,
    );
  });
});

// SES-919: connect login is an internal continuation, not an OAuth code flow.
describe("SES-919 unauthenticated connect with a CIMD anchor", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, "code"] as const)(
    "completes social login with response_type=%s",
    async (responseType) => {
      const { oauthApp, u2App, env } = await getTestServer();
      env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
      mockFetchJson(validDocument());
      await env.data.clients.create("tenantId", {
        client_id: CIMD_URL,
        name: "CIMD anchor",
        app_type: "regular_web",
      });
      await env.data.tenants.update("tenantId", {
        default_client_id: CIMD_URL,
        flags: {
          client_id_metadata_document_registration: true,
          enable_dynamic_client_registration: true,
        },
      });
      const start = await oauthApp.request(
        `/connect/start?${new URLSearchParams({
          domain: "publisher.com",
          return_to: "https://publisher.com/wp-admin/connect-callback",
          state: "csrf-abc",
        })}`,
        { headers: { "tenant-id": "tenantId" } },
        env,
      );
      expect(start.status).toBe(302);
      const state = new URL(
        start.headers.get("location")!,
        "http://localhost",
      ).searchParams.get("state")!;
      const consent = await u2App.request(
        `/connect/start?state=${state}`,
        {
          headers: { "tenant-id": "tenantId" },
        },
        env,
      );
      expect(consent.status).toBe(302);
      expect(consent.headers.get("location")).toMatch(/\/login(?:\?|\/)/);
      const loginSession = await env.data.loginSessions.get("tenantId", state);
      expect(loginSession!.authParams.client_id).toBe(CIMD_URL);
      expect(loginSession!.authParams.code_challenge).toBeUndefined();
      const query = new URLSearchParams({
        client_id: CIMD_URL,
        state,
        connection: "mock-strategy",
      });
      if (responseType) query.set("response_type", responseType);
      const response = await oauthApp.request(
        `/authorize?${query}`,
        {
          headers: { "tenant-id": "tenantId" },
        },
        env,
      );
      expect(response.status, await response.text()).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/authorize",
      );
      const callback = await oauthApp.request(
        "/login/callback?state=code&code=entra-mismatch",
        { headers: { "tenant-id": "tenantId" } },
        env,
      );
      expect(callback.status, await callback.text()).toBe(302);
      const resume = await oauthApp.request(
        `/authorize/resume?state=${state}`,
        { headers: { "tenant-id": "tenantId" } },
        env,
      );
      expect(resume.status, await resume.text()).toBe(302);
      expect(resume.headers.get("location")).toBe(
        `/u2/connect/start?state=${state}`,
      );
      expect(resume.headers.get("set-cookie")).toBeTruthy();
      const after = await env.data.loginSessions.get("tenantId", state);
      expect(after?.authParams.redirect_uri).toBeUndefined();
      expect(after?.authParams.response_type).toBeUndefined();
      expect(after?.session_id).toBeTruthy();
    },
  );
});

describe("connect continuation validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "missing",
    "ordinary",
    "expired-time",
    "expired-state",
    "completed",
    "failed",
    "other-client",
    "stored-redirect",
    "stored-response-type",
    "request-redirect",
    "other-response-type",
  ])("keeps PKCE enforcement for %s sessions or requests", async (scenario) => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());
    const session = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(
        Date.now() + (scenario === "expired-time" ? -60000 : 60000),
      ).toISOString(),
      authParams: {
        client_id: scenario === "other-client" ? "clientId" : CIMD_URL,
        ...(scenario === "stored-redirect"
          ? { redirect_uri: "https://rp.example.com/callback" }
          : {}),
        ...(scenario === "stored-response-type"
          ? { response_type: "code" as const }
          : {}),
      },
      csrf_token: "csrf",
      state_data: JSON.stringify(
        scenario === "ordinary"
          ? {}
          : {
              connect: {
                domain: "publisher.com",
                return_to: "https://publisher.com/callback",
                caller_state: "csrf",
              },
            },
      ),
    });
    const terminalState = {
      "expired-state": "expired",
      completed: "completed",
      failed: "failed",
    }[scenario];
    if (terminalState) {
      await env.data.loginSessions.update("tenantId", session.id, {
        state: terminalState as "expired" | "completed" | "failed",
      });
    }
    const query = new URLSearchParams({
      client_id: CIMD_URL,
      connection: "mock-strategy",
      state: scenario === "missing" ? "unknown" : session.id,
      response_type:
        scenario === "other-response-type" ? "code id_token" : "code",
    });
    if (scenario === "request-redirect")
      query.set("redirect_uri", "https://rp.example.com/callback");
    const response = await oauthApp.request(
      `/authorize?${query}`,
      {
        headers: { "tenant-id": "tenantId" },
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "PKCE with code_challenge_method=S256 is required",
    );
    expect(
      await env.data.codes.get("tenantId", "code", "oauth2_state"),
    ).toBeNull();
  });

  it("still rejects an unregistered origin on a valid connect continuation", async () => {
    const { oauthApp, env } = await getTestServer();
    await enableCimd(env);
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());
    const session = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 60000).toISOString(),
      authParams: { client_id: CIMD_URL },
      csrf_token: "csrf",
      state_data: JSON.stringify({ connect: { domain: "publisher.com" } }),
    });
    const query = new URLSearchParams({
      client_id: CIMD_URL,
      connection: "mock-strategy",
      state: session.id,
    });
    const response = await oauthApp.request(
      `/authorize?${query}`,
      {
        headers: {
          "tenant-id": "tenantId",
          origin: "https://unregistered.example",
        },
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Origin https://unregistered.example not allowed",
    );
  });
});

// #1731: a CIMD client_id is a URL shared by every tenant that uses the
// client, so `clients` holds one stub row per tenant. State-keyed hops
// (/login/callback, /authorize/resume) must take the tenant from the login
// session, never from an unscoped `getByClientId` that picks an arbitrary
// tenant's stub.
describe("CIMD state-keyed hops with stubs in several tenants (#1731)", () => {
  afterEach(() => vi.restoreAllMocks());

  const OTHER_TENANT = "otherTenant";

  async function setupTwoTenants(otherFlagEnabled: boolean) {
    const server = await getTestServer();
    const { env } = server;
    env.ALLOW_PRIVATE_OUTBOUND_FETCH = true;
    mockFetchJson(validDocument());

    await env.data.tenants.create({
      id: OTHER_TENANT,
      friendly_name: "Other Tenant",
      audience: "https://other.example.com",
      sender_email: "login@other.example.com",
      sender_name: "Other",
      flags: otherFlagEnabled
        ? { client_id_metadata_document_registration: true }
        : undefined,
    });
    await env.data.connections.create(OTHER_TENANT, {
      id: "mock-strategy",
      name: "mock-strategy",
      strategy: "mock-strategy",
      options: {
        client_id: "otherMockClientId",
        client_secret: "otherMockClientSecret",
      },
    });
    // The other tenant's stub is inserted FIRST, so an unscoped
    // `SELECT … WHERE client_id = ? LIMIT 1` returns it.
    await env.data.clients.create(OTHER_TENANT, {
      client_id: CIMD_URL,
      name: "Example MCP Client",
      app_type: "regular_web",
      client_metadata: { cimd: "true" },
    });
    await enableCimd(env);

    return server;
  }

  async function runSocialLogin(
    server: Awaited<ReturnType<typeof getTestServer>>,
  ) {
    const { oauthApp, env } = server;

    // /authorize carries the tenant (here via the header, in production via
    // the host). It upserts the session tenant's own stub row.
    const authorize = await oauthApp.request(
      `/authorize?${new URLSearchParams({
        client_id: CIMD_URL,
        redirect_uri: "https://rp.example.com/callback",
        response_type: "code",
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "xyz",
        connection: "mock-strategy",
      })}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(authorize.status, await authorize.text()).toBe(302);
    expect(authorize.headers.get("location")).toBe(
      "https://example.com/authorize",
    );
    expect(await env.data.clients.get("tenantId", CIMD_URL)).not.toBeNull();

    const stateCode = await env.data.codes.get(
      "tenantId",
      "code",
      "oauth2_state",
    );
    const loginId = stateCode?.login_id;
    if (!loginId) throw new Error("oauth2_state code missing");

    // The IdP returns to the state-keyed callback with no tenant on the
    // request: no header, issuer host, and more than one tenant.
    const callback = await oauthApp.request(
      "/login/callback?state=code&code=foo@example.com",
      {},
      env,
    );
    expect(callback.status, await callback.text()).toBe(302);
    const callbackLocation = new URL(
      callback.headers.get("location") ?? "",
      "http://localhost:3000",
    );
    expect(callbackLocation.pathname).toBe("/authorize/resume");
    expect(callbackLocation.searchParams.get("state")).toBe(loginId);

    const resume = await oauthApp.request(
      `/authorize/resume?state=${loginId}`,
      {},
      env,
    );
    expect(resume.status, await resume.text()).toBe(302);
    const resumeLocation = new URL(resume.headers.get("location") ?? "");
    expect(resumeLocation.origin + resumeLocation.pathname).toBe(
      "https://rp.example.com/callback",
    );
    expect(resumeLocation.searchParams.get("state")).toBe("xyz");
    const code = resumeLocation.searchParams.get("code");
    if (!code) throw new Error("authorization code missing");

    return { code, loginId };
  }

  async function expectFlowInSessionTenant(
    env: Awaited<ReturnType<typeof getTestServer>>["env"],
    code: string,
    loginId: string,
  ) {
    // The code and the user belong to the session's tenant only.
    const codeRow = await env.data.codes.get(
      "tenantId",
      code,
      "authorization_code",
    );
    expect(codeRow?.login_id).toBe(loginId);
    expect(
      await env.data.users.get("tenantId", "mock-strategy|foo"),
    ).not.toBeNull();
    expect(await env.data.users.get(OTHER_TENANT, "mock-strategy|foo")).toBe(
      null,
    );
    const { users: otherUsers } = await env.data.users.list(OTHER_TENANT);
    expect(otherUsers.length).toBe(0);
    // The login is logged under the session's tenant, never the other one.
    const logs = await env.data.logs.list("tenantId");
    expect(logs.logs.map((log) => log.type)).toContain("s");
    const otherLogs = await env.data.logs.list(OTHER_TENANT);
    expect(otherLogs.logs.length).toBe(0);
  }

  it("resumes in the session's tenant when only it has the CIMD flag", async () => {
    const server = await setupTwoTenants(false);
    const { code, loginId } = await runSocialLogin(server);
    await expectFlowInSessionTenant(server.env, code, loginId);
  });

  it("resumes in the session's tenant when both tenants have the CIMD flag", async () => {
    const server = await setupTwoTenants(true);
    const { code, loginId } = await runSocialLogin(server);
    await expectFlowInSessionTenant(server.env, code, loginId);
  });

  it("getEnrichedClient resolves the tenant it is given", async () => {
    const { env } = await setupTwoTenants(true);
    await env.data.clients.create("tenantId", {
      client_id: CIMD_URL,
      name: "Example MCP Client",
      app_type: "regular_web",
      client_metadata: { cimd: "true" },
    });

    const client = await getEnrichedClient(env, CIMD_URL, "tenantId");
    expect(client.tenant.id).toBe("tenantId");
    expect(client.connections.map((c) => c.id)).toContain("email");
  });

  it("getEnrichedClient refuses to guess between several tenants' stubs", async () => {
    const { env } = await setupTwoTenants(true);
    await env.data.clients.create("tenantId", {
      client_id: CIMD_URL,
      name: "Example MCP Client",
      app_type: "regular_web",
      client_metadata: { cimd: "true" },
    });

    await expect(getEnrichedClient(env, CIMD_URL)).rejects.toThrow(
      /tenant_id is required/,
    );
  });
});
