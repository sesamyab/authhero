import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";

// #1731: a URL (CIMD) client_id has one stub row per tenant that uses it.
describe("multi-tenant CIMD client_ids", () => {
  const CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";

  async function setup() {
    const { data } = getTestServer();
    for (const id of ["otherTenant", "tenantId"]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
    }
    return data;
  }

  it("getByClientId returns null when a URL client_id has rows in several tenants", async () => {
    const data = await setup();
    // The other tenant's stub goes first, so an unscoped LIMIT 1 returns it.
    await data.clients.create("otherTenant", {
      client_id: CIMD_URL,
      name: "Claude",
      client_metadata: { cimd: "true" },
    });

    const single = await data.clients.getByClientId(CIMD_URL);
    expect(single?.tenant_id).toBe("otherTenant");

    await data.clients.create("tenantId", {
      client_id: CIMD_URL,
      name: "Claude",
      client_metadata: { cimd: "true" },
    });

    expect(await data.clients.getByClientId(CIMD_URL)).toBeNull();
    expect((await data.clients.get("tenantId", CIMD_URL))?.client_id).toBe(
      CIMD_URL,
    );
  });

  it("login sessions report the tenant they belong to", async () => {
    const data = await setup();
    const created = await data.loginSessions.create("tenantId", {
      csrf_token: "csrf",
      authParams: { client_id: CIMD_URL },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(created.tenant_id).toBe("tenantId");

    // State-keyed routes look the session up before the tenant is known.
    const byId = await data.loginSessions.get("", created.id);
    expect(byId?.tenant_id).toBe("tenantId");
    if (!byId) throw new Error("login session not found");

    // Writing the session back must not move it to another tenant.
    await data.loginSessions.update("tenantId", created.id, {
      ...byId,
      tenant_id: "otherTenant",
    });
    const after = await data.loginSessions.get("tenantId", created.id);
    expect(after?.tenant_id).toBe("tenantId");
  });
});
