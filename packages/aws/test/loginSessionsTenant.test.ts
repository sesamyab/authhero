import { afterEach, describe, expect, it } from "vitest";
import { getTestServer, teardownTestServer } from "./helpers/test-server";

// #1731: state-keyed routes take the flow's tenant from the login session.
describe("login session tenant", () => {
  afterEach(async () => {
    await teardownTestServer();
  });

  it("reports the tenant the session belongs to", async () => {
    const { data } = await getTestServer();
    const created = await data.loginSessions.create("tenantId", {
      csrf_token: "csrf",
      authParams: { client_id: "https://claude.ai/oauth/metadata" },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(created.tenant_id).toBe("tenantId");

    const fetched = await data.loginSessions.get("tenantId", created.id);
    expect(fetched?.tenant_id).toBe("tenantId");
    if (!fetched) throw new Error("login session not found");

    // Writing the session back must not rewrite its tenant attribute.
    await data.loginSessions.update("tenantId", created.id, {
      ...fetched,
      tenant_id: "otherTenant",
    });
    const after = await data.loginSessions.get("tenantId", created.id);
    expect(after?.tenant_id).toBe("tenantId");
  });
});
