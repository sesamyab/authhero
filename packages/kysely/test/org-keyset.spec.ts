import { describe, expect, it, beforeEach } from "vitest";
import { encodeCursor } from "@authhero/adapter-interfaces";
import { getTestServer } from "./helpers/test-server";

// Checkpoint (from/take) pagination for the organization-scoped lists:
// invitations and enabled connections.
describe("organization keyset pagination (from/take)", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];
  const tenantId = "tenantId";
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
    const server = await getTestServer();
    data = server.data;
    await data.tenants.create({
      id: tenantId,
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
    await data.organizations.create(tenantId, { id: "org-a", name: "org-a" });
    await data.organizations.create(tenantId, { id: "org-b", name: "org-b" });
  });

  describe("invitations", () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        await data.invites.create(tenantId, {
          organization_id: "org-a",
          inviter: { name: "Inviter" },
          invitee: { email: `a-${pad(i)}@example.com` },
          invitation_url: "https://example.com/invite",
          client_id: "client_123",
        });
      }
      for (let i = 0; i < 3; i++) {
        await data.invites.create(tenantId, {
          organization_id: "org-b",
          inviter: { name: "Inviter" },
          invitee: { email: `b-${pad(i)}@example.com` },
          invitation_url: "https://example.com/invite",
          client_id: "client_123",
        });
      }
    });

    it("walks only the organization's invitations via next", async () => {
      const { seen, pages } = await walk(
        (from) =>
          data.invites
            .list(tenantId, {
              q: "organization_id:org-a",
              take: 10,
              from,
            })
            .then((r) => ({ items: r.invites, next: r.next })),
        (i) => i.id!,
      );
      expect(new Set(seen).size).toBe(25);
      expect(seen).toHaveLength(25);
      expect(pages).toBe(3);
    });
  });

  describe("enabled connections", () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        const id = `con-${pad(i)}`;
        await data.connections.create(tenantId, {
          id,
          name: `connection-${i}`,
          strategy: "mock-strategy",
          options: {},
        });
        await data.organizationConnections.create(tenantId, "org-a", {
          connection_id: id,
        });
      }
    });

    it("walks every enabled connection exactly once via next", async () => {
      const { seen, pages } = await walk(
        (from) =>
          data.organizationConnections.listCheckpoint!(tenantId, "org-a", {
            take: 10,
            from,
          }).then((r) => ({ items: r.connections, next: r.next })),
        (c) => c.connection_id,
      );
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual([...seen].sort());
      expect(pages).toBe(3);
    });

    it("resolves connection details and scopes to the organization", async () => {
      const own = await data.organizationConnections.listCheckpoint!(
        tenantId,
        "org-a",
        { take: 1 },
      );
      expect(own.connections[0]!.connection?.name).toBe("connection-0");
      const other = await data.organizationConnections.listCheckpoint!(
        tenantId,
        "org-b",
        { take: 10 },
      );
      expect(other.connections).toHaveLength(0);
    });
  });

  describe("user permissions cursor", () => {
    it("rejects a malformed composite cursor with 400", async () => {
      await expect(
        data.userPermissions.listCheckpoint!(tenantId, "user", {
          from: encodeCursor({ s: "x", i: "not-json" }),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
