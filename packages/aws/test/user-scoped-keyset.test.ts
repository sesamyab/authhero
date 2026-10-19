import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTestServer,
  clearTestData,
  teardownTestServer,
} from "./helpers/test-server";

const TENANT = "tenantId";
const USER = "email|user";
const pad = (i: number) => i.toString().padStart(2, "0");

// Checkpoint (from/take) pagination for user permissions, user roles and
// organization connections on DynamoDB.
describe("user-scoped keyset pagination (aws)", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];

  beforeEach(async () => {
    ({ data } = await getTestServer());
    await data.tenants.create({
      id: TENANT,
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
  });

  afterEach(async () => {
    await clearTestData();
  });

  afterAll(async () => {
    await teardownTestServer();
  });

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
      if (!res.next || res.items.length === 0) break;
      from = res.next;
      if (pages > 10) throw new Error("cursor walk did not terminate");
    }
    return seen;
  }

  it("walks user permissions in the requested organization partition", async () => {
    for (let i = 0; i < 25; i++) {
      await data.userPermissions.create(TENANT, USER, {
        user_id: USER,
        resource_server_identifier: `https://api-${i % 3}.example.com`,
        permission_name: `perm:${pad(i)}`,
      });
    }
    await data.userPermissions.create(
      TENANT,
      USER,
      {
        user_id: USER,
        resource_server_identifier: "https://api-0.example.com",
        permission_name: "perm:org-only",
      },
      "org-a",
    );

    const seen = await walk(
      (from) =>
        data.userPermissions.listCheckpoint!(TENANT, USER, {
          take: 10,
          from,
        }).then((r) => ({ items: r.permissions, next: r.next })),
      (p) => `${p.resource_server_identifier}|${p.permission_name}`,
    );
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain("https://api-0.example.com|perm:org-only");

    const org = await data.userPermissions.listCheckpoint!(
      TENANT,
      USER,
      { take: 10 },
      "org-a",
    );
    expect(org.permissions.map((p) => p.permission_name)).toEqual([
      "perm:org-only",
    ]);
  });

  it("walks user roles and skips assignments to deleted roles", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const role = await data.roles.create(TENANT, { name: `role-${pad(i)}` });
      await data.userRoles.create(TENANT, USER, role.id);
      ids.push(role.id);
    }
    const seen = await walk(
      (from) =>
        data.userRoles.listCheckpoint!(TENANT, USER, { take: 10, from }).then(
          (r) => ({ items: r.roles, next: r.next }),
        ),
      (r) => r.id,
    );
    expect([...seen].sort()).toEqual([...ids].sort());

    await data.roles.remove(TENANT, ids[0]!);
    const after = await walk(
      (from) =>
        data.userRoles.listCheckpoint!(TENANT, USER, { take: 10, from }).then(
          (r) => ({ items: r.roles, next: r.next }),
        ),
      (r) => r.id,
    );
    expect(after).toHaveLength(24);
  });

  it("walks organization connections", async () => {
    await data.organizations.create(TENANT, { id: "org-a", name: "org-a" });
    for (let i = 0; i < 25; i++) {
      const id = `con-${pad(i)}`;
      await data.connections.create(TENANT, {
        id,
        name: `connection-${i}`,
        strategy: "mock-strategy",
        options: {},
      });
      await data.organizationConnections.create(TENANT, "org-a", {
        connection_id: id,
      });
    }
    const seen = await walk(
      (from) =>
        data.organizationConnections.listCheckpoint!(TENANT, "org-a", {
          take: 10,
          from,
        }).then((r) => ({ items: r.connections, next: r.next })),
      (c) => c.connection_id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe("con-00");
  });
});
