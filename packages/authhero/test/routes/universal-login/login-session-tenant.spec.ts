import { describe, expect, it } from "vitest";
import { getTestServer } from "../../helpers/test-server";
import { resolveLoginSessionTenant } from "../../../src/helpers/login-session-tenant";

describe("resolveLoginSessionTenant", () => {
  it("rejects a session of another tenant than the request", () => {
    expect(resolveLoginSessionTenant("a", { tenant_id: "b" })).toEqual({
      ok: false,
    });
  });

  it("prefers the request tenant and falls back to the session's", () => {
    expect(resolveLoginSessionTenant("a", { tenant_id: "a" })).toEqual({
      ok: true,
      tenantId: "a",
    });
    expect(resolveLoginSessionTenant(undefined, { tenant_id: "b" })).toEqual({
      ok: true,
      tenantId: "b",
    });
    expect(resolveLoginSessionTenant("a", {})).toEqual({
      ok: true,
      tenantId: "a",
    });
    expect(resolveLoginSessionTenant(undefined, {})).toEqual({
      ok: true,
      tenantId: undefined,
    });
  });
});

// #1732 review: state-keyed routes take the flow's tenant from the login
// session, but a session of tenant B must never be served on a request that
// resolved tenant A from its host. The kysely test adapter's
// loginSessions.get ignores the tenant argument, so these requests do load
// tenant B's session and the check has to come from the route.
describe("login session from another tenant than the request", () => {
  async function setup() {
    const server = await getTestServer();
    const { env } = server;
    await env.data.tenants.create({
      id: "tenantB",
      friendly_name: "Tenant B Phish",
      audience: "https://b.example.com",
      sender_email: "login@b.example.com",
      sender_name: "Tenant B",
    });
    await env.data.connections.create("tenantB", {
      id: "b-password",
      name: "Username-Password-Authentication",
      strategy: "Username-Password-Authentication",
      options: {},
    });
    await env.data.clients.create("tenantB", {
      client_id: "clientB",
      name: "Client B",
      callbacks: ["https://b.example.com/callback"],
    });
    const session = await env.data.loginSessions.create("tenantB", {
      csrf_token: "csrf",
      authParams: {
        client_id: "clientB",
        redirect_uri: "https://b.example.com/callback",
        response_type: "code",
        scope: "openid",
        state: "rp-state",
      },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    return { ...server, sessionId: session.id };
  }

  it("u/ screens treat it as a missing login session", async () => {
    const { universalApp, env, sessionId } = await setup();

    const onA = await universalApp.request(
      `/login/identifier?state=${sessionId}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    const body = await onA.text();
    expect(onA.status, body).toBe(400);
    // The same error page a missing login session gets.
    expect(body).toContain("<title>Error - 400</title>");
    expect(body).not.toContain("Tenant B Phish");

    // Control: the same session renders on its own tenant.
    const onB = await universalApp.request(
      `/login/identifier?state=${sessionId}`,
      { headers: { "tenant-id": "tenantB" } },
      env,
    );
    expect(onB.status, await onB.text()).toBe(200);
  });

  it("u2 screens treat it as a missing login session", async () => {
    const { u2App, env, sessionId } = await setup();

    const onA = await u2App.request(
      `/login/identifier?state=${sessionId}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    const body = await onA.text();
    expect(onA.status, body).toBe(400);
    expect(body).not.toContain("Tenant B Phish");
  });

  it("/authorize/resume treats it as an unknown state", async () => {
    const { oauthApp, env, sessionId } = await setup();
    await env.data.loginSessions.update("tenantB", sessionId, {
      state: "authenticated",
    });

    const onA = await oauthApp.request(
      `/authorize/resume?state=${sessionId}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(onA.status).toBe(403);
    expect(await onA.text()).toContain("State not found");
  });

  it("/authorize/resume rejects it before the cross-domain hop", async () => {
    const { oauthApp, env, sessionId } = await setup();
    await env.data.customDomains.create("tenantB", {
      domain: "login.b.example.com",
      custom_domain_id: "b-domain",
      type: "auth0_managed_certs",
    });
    await env.data.loginSessions.update("tenantB", sessionId, {
      state: "authenticated",
      authorization_url:
        "https://login.b.example.com/authorize?client_id=clientB",
    });

    const onA = await oauthApp.request(
      `/authorize/resume?state=${sessionId}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(onA.status).toBe(403);
    expect(await onA.text()).toContain("State not found");
    expect(onA.headers.get("location")).toBeNull();
  });

  it("/login/callback treats it as an unknown state", async () => {
    const { oauthApp, env, sessionId } = await setup();
    await env.data.connections.create("tenantB", {
      id: "mock-strategy",
      name: "mock-strategy",
      strategy: "mock-strategy",
      options: { client_id: "bMockClientId", client_secret: "bSecret" },
    });
    // Codes are tenant-scoped, but the state code only carries the session
    // id: a code on tenant A pointing at tenant B's session must not let the
    // tenant-blind session lookup pull the flow into tenant B.
    await env.data.codes.create("tenantId", {
      code_id: "b-state",
      code_type: "oauth2_state",
      login_id: sessionId,
      connection_id: "mock-strategy",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });

    const onA = await oauthApp.request(
      "/login/callback?state=b-state&code=foo@example.com",
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(onA.status, await onA.text()).toBe(302);
    const location = new URL(
      onA.headers.get("location") ?? "",
      "http://localhost:3000",
    );
    expect(location.pathname).toBe("/u/error");
    expect(await env.data.users.get("tenantB", "mock-strategy|foo")).toBe(null);
    const session = await env.data.loginSessions.get("tenantB", sessionId);
    expect(session?.state).toBe("pending");
  });
});
