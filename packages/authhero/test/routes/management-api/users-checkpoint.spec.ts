import { describe, it, expect, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import {
  AuthorizationResponseType,
  LoginSessionState,
} from "@authhero/adapter-interfaces";

// Checkpoint (from/take) pagination on the /users/{id}/... list routes.
describe("users checkpoint pagination", () => {
  const tenantId = "tenantId";
  const userId = "email|checkpoint-user";
  const pad = (i: number) => i.toString().padStart(2, "0");
  let client: any;
  let env: Awaited<ReturnType<typeof getTestServer>>["env"];
  let token: string;

  beforeEach(async () => {
    const server = await getTestServer();
    env = server.env;
    client = testClient(server.managementApp, env);
    token = await getAdminToken();
    await env.data.users.create(tenantId, {
      user_id: userId,
      email: "checkpoint@example.com",
      email_verified: true,
      connection: "email",
      provider: "email",
      is_social: false,
    });
  });

  async function get(
    route: any,
    query: Record<string, string>,
    userParam = userId,
  ) {
    return route.$get(
      {
        param: { user_id: userParam },
        query,
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async function walk(
    route: any,
    itemsKey: string,
    key: (item: any) => string,
    extra: Record<string, string> = {},
  ) {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const response = await get(route, {
        ...extra,
        take: "10",
        ...(from ? { from } : {}),
      });
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

  it("walks user sessions", async () => {
    const loginSession = await env.data.loginSessions.create(tenantId, {
      csrf_token: "csrf",
      authParams: {
        client_id: "clientId",
        response_type: AuthorizationResponseType.CODE,
        scope: "openid",
        state: "state",
      },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      ip: "127.0.0.1",
      useragent: "vitest",
      state: LoginSessionState.PENDING,
    });
    for (let i = 0; i < 25; i++) {
      await env.data.sessions.create(tenantId, {
        id: `session-${pad(i)}`,
        user_id: userId,
        login_session_id: loginSession.id,
        device: {
          last_ip: "",
          initial_ip: "",
          last_user_agent: "",
          initial_user_agent: "",
          initial_asn: "",
          last_asn: "",
        },
        clients: [],
      });
    }
    const { seen, pages } = await walk(
      client.users[":user_id"].sessions,
      "sessions",
      (s) => s.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks user logs and honors the q filter", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.logs.create(tenantId, {
        log_id: `log-${pad(i)}`,
        type: "s",
        date: `2026-01-01T00:00:${pad(i)}.000Z`,
        user_id: userId,
        isMobile: false,
      });
    }
    await env.data.logs.create(tenantId, {
      log_id: "log-other",
      type: "s",
      date: "2026-01-01T00:01:00.000Z",
      user_id: "email|someone-else",
      isMobile: false,
    });
    const { seen, pages } = await walk(
      client.users[":user_id"].logs,
      "logs",
      (l) => l.log_id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain("log-other");
    expect(pages).toBe(3);
  });

  it("walks user organizations", async () => {
    for (let i = 0; i < 25; i++) {
      const org = await env.data.organizations.create(tenantId, {
        id: `org-${pad(i)}`,
        name: `org-${pad(i)}`,
      });
      await env.data.userOrganizations.create(tenantId, {
        user_id: userId,
        organization_id: org.id,
      });
    }
    const { seen, pages } = await walk(
      client.users[":user_id"].organizations,
      "organizations",
      (o) => o.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks user permissions and rejects sort/q in checkpoint mode", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.userPermissions.create(tenantId, userId, {
        user_id: userId,
        resource_server_identifier: "https://api.example.com",
        permission_name: `perm:${pad(i)}`,
      });
    }
    const { seen, pages } = await walk(
      client.users[":user_id"].permissions,
      "permissions",
      (p) => `${p.resource_server_identifier}|${p.permission_name}`,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    const rejected = await get(client.users[":user_id"].permissions, {
      take: "10",
      q: "permission_name:perm",
    });
    expect(rejected.status).toBe(400);

    // The offset shape (bare array) is unchanged.
    const plain = await get(client.users[":user_id"].permissions, {});
    expect(Array.isArray(await plain.json())).toBe(true);
  });

  it("walks user roles", async () => {
    for (let i = 0; i < 25; i++) {
      const role = await env.data.roles.create(tenantId, {
        name: `role-${pad(i)}`,
      });
      await env.data.userRoles.create(tenantId, userId, role.id, "");
    }
    const { seen, pages } = await walk(
      client.users[":user_id"].roles,
      "roles",
      (r) => r.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    const plain = await get(client.users[":user_id"].roles, {});
    expect(Array.isArray(await plain.json())).toBe(true);
  });
});
