import { describe, expect, it, beforeEach } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
  decodeCursor,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

// Checkpoint (from/take) pagination for the /users/{id}/... list endpoints:
// sessions, organizations, permissions and roles.
describe("user-scoped keyset pagination (from/take)", () => {
  let data: ReturnType<typeof getTestServer>["data"];
  const tenantId = "t1";
  const userId = "email|user";
  const pad = (i: number) => i.toString().padStart(2, "0");

  async function walk<T>(
    fetchPage: (
      from: string | undefined,
    ) => Promise<{ items: T[]; next?: string }>,
    key: (item: T) => string,
  ) {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await fetchPage(from);
      pages++;
      seen.push(...res.items.map(key));
      if (!res.next) break;
      from = res.next;
      if (pages > 20) throw new Error("cursor walk did not terminate");
    }
    return { seen, pages };
  }

  beforeEach(async () => {
    const server = getTestServer();
    data = server.data;

    await data.tenants.create({ id: tenantId, name: "Tenant 1" });
    await data.clients.create(tenantId, {
      client_id: "client123",
      client_secret: "clientSecret",
      name: "Test Client",
      callbacks: ["https://example.com/callback"],
      allowed_logout_urls: ["https://example.com/callback"],
      web_origins: ["https://example.com"],
    });
    await data.users.create(tenantId, {
      user_id: userId,
      email: "user@example.com",
      email_verified: true,
      connection: "email",
      provider: "email",
      is_social: false,
    });
  });

  describe("sessions", () => {
    beforeEach(async () => {
      const loginSession = await data.loginSessions.create(tenantId, {
        csrf_token: "csrf",
        authParams: {
          client_id: "client123",
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
        await data.sessions.create(tenantId, {
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
    });

    it("walks every session exactly once via an opaque next cursor", async () => {
      const q = `user_id:${userId.replace("|", "\\|")}`;
      const { seen, pages } = await walk(
        (from) =>
          data.sessions
            .list(tenantId, { q, take: 10, from })
            .then((r) => ({ items: r.sessions, next: r.next })),
        (s) => s.id,
      );
      expect(new Set(seen).size).toBe(25);
      expect(seen).toHaveLength(25);
      expect(pages).toBe(3);

      const first = await data.sessions.list(tenantId, { q, take: 10 });
      expect(decodeCursor(first.next!)).not.toBeNull();
    });
  });

  describe("user organizations", () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        const org = await data.organizations.create(tenantId, {
          id: `org-${pad(i)}`,
          name: `org-${pad(i)}`,
          display_name: `Org ${i}`,
        });
        await data.userOrganizations.create(tenantId, {
          user_id: userId,
          organization_id: org.id,
        });
      }
    });

    it("walks every organization exactly once via next", async () => {
      const { seen, pages } = await walk(
        (from) =>
          data.userOrganizations
            .listUserOrganizations(tenantId, userId, { take: 10, from })
            .then((r) => ({ items: r.organizations, next: r.next })),
        (o) => o.id,
      );
      expect(new Set(seen).size).toBe(25);
      expect(seen).toHaveLength(25);
      expect(pages).toBe(3);
    });

    it("is stable when a membership is added mid-walk", async () => {
      const page1 = await data.userOrganizations.listUserOrganizations(
        tenantId,
        userId,
        { take: 10 },
      );
      const org = await data.organizations.create(tenantId, {
        id: "org-late",
        name: "org-late",
      });
      await data.userOrganizations.create(tenantId, {
        user_id: userId,
        organization_id: org.id,
      });
      const page2 = await data.userOrganizations.listUserOrganizations(
        tenantId,
        userId,
        { take: 10, from: page1.next },
      );
      const ids1 = new Set(page1.organizations.map((o) => o.id));
      for (const o of page2.organizations) expect(ids1.has(o.id)).toBe(false);
    });
  });

  describe("user permissions", () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        await data.resourceServers.create(tenantId, {
          id: `rs-${i}`,
          name: `API ${i}`,
          identifier: `https://api-${i}.example.com`,
          scopes: [],
        });
      }
      for (let i = 0; i < 25; i++) {
        await data.userPermissions.create(tenantId, userId, {
          user_id: userId,
          resource_server_identifier: `https://api-${i % 3}.example.com`,
          permission_name: `perm:${pad(i)}`,
        });
      }
      // Same permission under an organization scope: a distinct row.
      await data.userPermissions.create(
        tenantId,
        userId,
        {
          user_id: userId,
          resource_server_identifier: "https://api-0.example.com",
          permission_name: "perm:00",
        },
        "org-a",
      );
    });

    it("walks every permission row exactly once, org scopes included", async () => {
      const { seen, pages } = await walk(
        (from) =>
          data.userPermissions.listCheckpoint!(tenantId, userId, {
            take: 10,
            from,
          }).then((r) => ({ items: r.permissions, next: r.next })),
        (p) =>
          `${p.resource_server_identifier}|${p.permission_name}|${p.organization_id ?? ""}`,
      );
      expect(new Set(seen).size).toBe(26);
      expect(seen).toHaveLength(26);
      expect(pages).toBe(3);
      expect(seen).toEqual([...seen].sort());
    });

    it("resolves the resource server name", async () => {
      const res = await data.userPermissions.listCheckpoint!(tenantId, userId, {
        take: 1,
      });
      expect(res.permissions[0]!.resource_server_name).toBe("API 0");
    });
  });

  describe("user roles", () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        const role = await data.roles.create(tenantId, {
          name: `role-${pad(i)}`,
        });
        await data.userRoles.create(tenantId, userId, role.id, "");
        // Held under an org scope too: must still appear once.
        if (i === 0) {
          await data.userRoles.create(tenantId, userId, role.id, "org-a");
        }
      }
    });

    it("walks every distinct role exactly once via next", async () => {
      const { seen, pages } = await walk(
        (from) =>
          data.userRoles.listCheckpoint!(tenantId, userId, {
            take: 10,
            from,
          }).then((r) => ({ items: r.roles, next: r.next })),
        (r) => r.id,
      );
      expect(new Set(seen).size).toBe(25);
      expect(seen).toHaveLength(25);
      expect(pages).toBe(3);
    });

    it("honors the organization scope filter", async () => {
      const res = await data.userRoles.listCheckpoint!(
        tenantId,
        userId,
        { take: 50 },
        "org-a",
      );
      expect(res.roles).toHaveLength(1);
      expect(res.next).toBeUndefined();
    });
  });
});
