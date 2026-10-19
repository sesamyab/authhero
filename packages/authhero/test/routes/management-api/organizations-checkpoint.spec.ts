import { describe, it, expect, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

// Checkpoint (from/take) pagination on the organization-scoped list routes.
describe("organizations checkpoint pagination", () => {
  const tenantId = "tenantId";
  const orgId = "org-checkpoint";
  const pad = (i: number) => i.toString().padStart(2, "0");
  let client: any;
  let env: Awaited<ReturnType<typeof getTestServer>>["env"];
  let token: string;

  beforeEach(async () => {
    const server = await getTestServer();
    env = server.env;
    client = testClient(server.managementApp, env);
    token = await getAdminToken();
    await env.data.organizations.create(tenantId, {
      id: orgId,
      name: orgId,
    });
  });

  async function walk(
    route: any,
    param: Record<string, string>,
    itemsKey: string,
    key: (item: any) => string,
  ) {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const response = await route.$get(
        {
          param,
          query: { take: "10", ...(from ? { from } : {}) },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(false);
      seen.push(...body[itemsKey].map(key));
      from = body.next;
      if (from) expect(from).not.toMatch(/^\d+$/);
      if (++pages > 6) throw new Error("cursor walk did not terminate");
    } while (from);
    return { seen, pages };
  }

  it("walks invitations scoped to the organization", async () => {
    await env.data.organizations.create(tenantId, {
      id: "org-other",
      name: "o",
    });
    for (let i = 0; i < 25; i++) {
      await env.data.invites.create(tenantId, {
        organization_id: orgId,
        inviter: { name: "Inviter" },
        invitee: { email: `a-${pad(i)}@example.com` },
        invitation_url: "https://example.com/invite",
        client_id: "clientId",
      });
    }
    await env.data.invites.create(tenantId, {
      organization_id: "org-other",
      inviter: { name: "Inviter" },
      invitee: { email: "other@example.com" },
      invitation_url: "https://example.com/invite",
      client_id: "clientId",
    });

    const { seen, pages } = await walk(
      client.organizations[":id"].invitations,
      { id: orgId },
      "invitations",
      (i) => i.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks enabled connections", async () => {
    for (let i = 0; i < 25; i++) {
      const id = `con-${pad(i)}`;
      await env.data.connections.create(tenantId, {
        id,
        name: `connection-${i}`,
        strategy: "mock-strategy",
        options: {},
      });
      await env.data.organizationConnections.create(tenantId, orgId, {
        connection_id: id,
      });
    }
    const { seen, pages } = await walk(
      client.organizations[":id"].enabled_connections,
      { id: orgId },
      "connections",
      (c) => c.connection_id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    // The offset shape (wrapped with totals) is unchanged.
    const offset = await client.organizations[":id"].enabled_connections.$get(
      {
        param: { id: orgId },
        query: {},
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await offset.json();
    expect(body.total).toBe(25);
  });

  it("walks organization member roles", async () => {
    const userId = "email|member";
    await env.data.users.create(tenantId, {
      user_id: userId,
      email: "member@example.com",
      email_verified: true,
      connection: "email",
      provider: "email",
      is_social: false,
    });
    for (let i = 0; i < 25; i++) {
      const role = await env.data.roles.create(tenantId, {
        name: `role-${pad(i)}`,
      });
      await env.data.userRoles.create(tenantId, userId, role.id, orgId);
    }
    const { seen, pages } = await walk(
      client.organizations[":id"].members[":user_id"].roles,
      { id: orgId, user_id: userId },
      "roles",
      (r) => r.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });
});
