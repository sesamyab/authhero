import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "../helpers/test-server";

describe("role permissions adapter", () => {
  let data: ReturnType<typeof getTestServer>["data"];
  const tenantId = "t1";
  let roleId: string;

  const permission = {
    resource_server_identifier: "urn:authhero:management",
    permission_name: "read:custom_domains",
  };

  beforeEach(async () => {
    const server = getTestServer();
    data = server.data;

    await data.tenants.create({ id: tenantId, name: "Tenant 1" });

    const role = await data.roles.create(tenantId, {
      name: "permissions-role",
      description: "Role for permission tests",
    });
    roleId = role.id;
  });

  it("is idempotent when assigning the same permission twice", async () => {
    expect(
      await data.rolePermissions.assign(tenantId, roleId, [permission]),
    ).toBe(true);
    expect(
      await data.rolePermissions.assign(tenantId, roleId, [permission]),
    ).toBe(true);

    const permissions = await data.rolePermissions.list(tenantId, roleId);
    expect(permissions.length).toBe(1);
  });

  it("reports success when removing a permission the role does not have", async () => {
    // The management API turns `false` into a 500, so an absent permission
    // must not read as a failure.
    expect(
      await data.rolePermissions.remove(tenantId, roleId, [permission]),
    ).toBe(true);
  });

  it("does not wipe every permission when given an empty array", async () => {
    await data.rolePermissions.assign(tenantId, roleId, [permission]);

    expect(await data.rolePermissions.assign(tenantId, roleId, [])).toBe(true);
    expect(await data.rolePermissions.remove(tenantId, roleId, [])).toBe(true);

    const permissions = await data.rolePermissions.list(tenantId, roleId);
    expect(permissions.length).toBe(1);
  });

  it("removes only the listed permissions", async () => {
    await data.rolePermissions.assign(tenantId, roleId, [
      permission,
      { ...permission, permission_name: "create:custom_domains" },
    ]);

    expect(
      await data.rolePermissions.remove(tenantId, roleId, [permission]),
    ).toBe(true);

    const permissions = await data.rolePermissions.list(tenantId, roleId);
    expect(permissions.map((p) => p.permission_name)).toEqual([
      "create:custom_domains",
    ]);
  });

  it("honors page and per_page in list", async () => {
    await data.rolePermissions.assign(
      tenantId,
      roleId,
      ["a", "b", "c", "d", "e"].map((n) => ({
        resource_server_identifier: "urn:authhero:management",
        permission_name: `read:${n}`,
      })),
    );

    const first = await data.rolePermissions.list(tenantId, roleId, {
      page: 0,
      per_page: 2,
    });
    const second = await data.rolePermissions.list(tenantId, roleId, {
      page: 1,
      per_page: 2,
    });
    const all = await data.rolePermissions.list(tenantId, roleId);

    expect(first.map((p) => p.permission_name)).toEqual(["read:a", "read:b"]);
    expect(second.map((p) => p.permission_name)).toEqual(["read:c", "read:d"]);
    expect(all).toHaveLength(5);
  });
});

describe("role permissions adapter on D1", () => {
  // D1 rejects statements that bind more than 100 parameters, and the admin
  // role carries hundreds of management scopes.
  const D1_MAX_BOUND_PARAMETERS = 100;
  const tenantId = "t1";

  const manyPermissions = Array.from({ length: 252 }, (_, i) => ({
    resource_server_identifier: "urn:authhero:management",
    permission_name: `read:resource_${i}`,
  }));

  async function setup() {
    const { data, db } = getTestServer();
    await data.tenants.create({ id: tenantId, name: "Tenant 1" });
    const role = await data.roles.create(tenantId, {
      name: "admin",
      description: "Role with many permissions",
    });

    const client = (db as any).$client as {
      prepare: (sql: string) => unknown;
    };
    const originalPrepare = client.prepare.bind(client);
    const boundParameters: number[] = [];
    client.prepare = (sql: string) => {
      if (sql.includes('"role_permissions"')) {
        boundParameters.push((sql.match(/\?/g) ?? []).length);
      }
      return originalPrepare(sql);
    };

    return { data, roleId: role.id, boundParameters };
  }

  it("assigns hundreds of permissions without exceeding the D1 parameter limit", async () => {
    const { data, roleId, boundParameters } = await setup();

    expect(
      await data.rolePermissions.assign(tenantId, roleId, manyPermissions),
    ).toBe(true);

    expect(Math.max(...boundParameters)).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const stored = await data.rolePermissions.list(tenantId, roleId);
    expect(stored).toHaveLength(manyPermissions.length);
  });

  it("removes hundreds of permissions without exceeding the D1 parameter limit", async () => {
    const { data, roleId, boundParameters } = await setup();
    await data.rolePermissions.assign(tenantId, roleId, manyPermissions);
    boundParameters.length = 0;

    expect(
      await data.rolePermissions.remove(tenantId, roleId, manyPermissions),
    ).toBe(true);

    expect(Math.max(...boundParameters)).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(await data.rolePermissions.list(tenantId, roleId)).toHaveLength(0);
  });
});
