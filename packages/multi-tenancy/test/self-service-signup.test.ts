import { beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import { MANAGEMENT_API_AUDIENCE } from "authhero";
import {
  chainSelfServiceHooks,
  createSelfServiceSignupHooks,
  DEFAULT_SELF_SERVICE_ROLE_NAME,
} from "../src/hooks/self-service-signup";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const CHILD = "tenant-1";

describe("self-service sign-up hooks", () => {
  let db: Kysely<Database>;
  let data: ReturnType<typeof createAdapters>;

  const ctx = () => ({ var: {}, env: { data } }) as any;
  const hooks = () =>
    createSelfServiceSignupHooks({ controlPlaneTenantId: CP });

  async function createUser(tenantId: string, id: string, verified: boolean) {
    await data.users.create(tenantId, {
      user_id: `auth2|${id}`,
      email: `${id}@example.com`,
      email_verified: verified,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });
    return `auth2|${id}`;
  }

  const registration = (
    tenantId: string,
    user: { user_id: string; email_verified: boolean },
  ) =>
    hooks().onExecutePostUserRegistration!(
      { ctx: ctx(), tenant: { id: tenantId }, user, request: {} } as any,
      {} as any,
    );

  const update = (tenantId: string, userId: string, updates: object) =>
    hooks().onExecutePostUserUpdate!(
      {
        ctx: ctx(),
        tenant: { id: tenantId },
        user_id: userId,
        updates,
        request: {},
      } as any,
      {} as any,
    );

  const globalRoles = async (tenantId: string, userId: string) =>
    (await data.userRoles.list(tenantId, userId, undefined, "")).map(
      (role) => role.name,
    );

  beforeEach(async () => {
    db = await createMigratedDb();
    data = createAdapters(db);
    await data.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await data.tenants.create({ id: CHILD, friendly_name: "Child" });
  });

  it("grants a user who registers verified the role with only create:tenants", async () => {
    const userId = await createUser(CP, "social", true);
    await registration(CP, { user_id: userId, email_verified: true });

    expect(await globalRoles(CP, userId)).toEqual([
      DEFAULT_SELF_SERVICE_ROLE_NAME,
    ]);
    const { roles } = await data.roles.list(CP, {});
    const role = roles.find((r) => r.name === DEFAULT_SELF_SERVICE_ROLE_NAME)!;
    const permissions = await data.rolePermissions.list(CP, role.id, {
      per_page: 100,
    });
    expect(
      permissions.map((p) => [p.resource_server_identifier, p.permission_name]),
    ).toEqual([[MANAGEMENT_API_AUDIENCE, "create:tenants"]]);
  });

  it("does not grant a user who registers with an unverified email", async () => {
    const userId = await createUser(CP, "password", false);
    await registration(CP, { user_id: userId, email_verified: false });

    expect(await globalRoles(CP, userId)).toEqual([]);
  });

  it("grants the role when the email becomes verified", async () => {
    const userId = await createUser(CP, "password", false);
    await registration(CP, { user_id: userId, email_verified: false });
    await update(CP, userId, { email_verified: true });

    expect(await globalRoles(CP, userId)).toEqual([
      DEFAULT_SELF_SERVICE_ROLE_NAME,
    ]);
  });

  it("ignores updates that do not verify the email", async () => {
    const userId = await createUser(CP, "password", false);
    await update(CP, userId, { name: "New name" });
    await update(CP, userId, { email_verified: false });

    expect(await globalRoles(CP, userId)).toEqual([]);
  });

  it("never grants on a child tenant", async () => {
    const userId = await createUser(CHILD, "child", true);
    await registration(CHILD, { user_id: userId, email_verified: true });
    await update(CHILD, userId, { email_verified: true });

    expect(await globalRoles(CHILD, userId)).toEqual([]);
    expect((await data.roles.list(CHILD, {})).roles).toEqual([]);
    expect((await data.roles.list(CP, {})).roles).toEqual([]);
  });

  it("is idempotent and shares one role between users", async () => {
    const first = await createUser(CP, "one", true);
    const second = await createUser(CP, "two", true);
    await registration(CP, { user_id: first, email_verified: true });
    await registration(CP, { user_id: first, email_verified: true });
    await update(CP, first, { email_verified: true });
    await registration(CP, { user_id: second, email_verified: true });

    const { roles } = await data.roles.list(CP, {});
    expect(
      roles.filter((r) => r.name === DEFAULT_SELF_SERVICE_ROLE_NAME),
    ).toHaveLength(1);
    expect(await globalRoles(CP, first)).toEqual([
      DEFAULT_SELF_SERVICE_ROLE_NAME,
    ]);
    expect(await globalRoles(CP, second)).toEqual([
      DEFAULT_SELF_SERVICE_ROLE_NAME,
    ]);
  });

  it("adds create:tenants to an existing role without removing other permissions", async () => {
    const role = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.rolePermissions.assign(CP, role.id, [
      {
        role_id: role.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: "read:logs",
      },
    ]);

    const userId = await createUser(CP, "social", true);
    await registration(CP, { user_id: userId, email_verified: true });

    const permissions = await data.rolePermissions.list(CP, role.id, {
      per_page: 100,
    });
    expect(permissions.map((p) => p.permission_name).sort()).toEqual([
      "create:tenants",
      "read:logs",
    ]);
  });

  it("repairs the permission for a user who already holds the role", async () => {
    const role = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    const userId = await createUser(CP, "social", true);
    await data.userRoles.create(CP, userId, role.id, "");

    await registration(CP, { user_id: userId, email_verified: true });

    const permissions = await data.rolePermissions.list(CP, role.id, {
      per_page: 100,
    });
    expect(permissions.map((p) => p.permission_name)).toEqual([
      "create:tenants",
    ]);
    expect(await globalRoles(CP, userId)).toEqual([
      DEFAULT_SELF_SERVICE_ROLE_NAME,
    ]);
  });

  it("finds the role when it is past the first page of roles", async () => {
    // The adapter's order is not guaranteed, so control the pages: a full
    // first page of other roles, the role only on the second.
    const existing = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    const others = Array.from({ length: 100 }, (_, i) => ({
      ...existing,
      id: `other-${i}`,
      name: `a-role-${i}`,
    }));
    const pages: Record<number, (typeof existing)[]> = {
      0: others,
      1: [existing],
    };
    const create = vi.spyOn(data.roles, "create");
    const paged = {
      ...data,
      roles: {
        ...data.roles,
        list: async (_tenant: string, params?: { page?: number }) => ({
          roles: pages[params?.page ?? 0] ?? [],
        }),
      },
    };

    const userId = await createUser(CP, "social", true);
    await hooks().onExecutePostUserRegistration!(
      {
        ctx: { var: {}, env: { data: paged } },
        tenant: { id: CP },
        user: { user_id: userId, email_verified: true },
        request: {},
      } as any,
      {} as any,
    );

    expect(create).not.toHaveBeenCalled();
    expect(
      (await data.userRoles.list(CP, userId, undefined, "")).map((r) => r.id),
    ).toEqual([existing.id]);
  });

  it("uses a custom role name", async () => {
    const userId = await createUser(CP, "social", true);
    await createSelfServiceSignupHooks({
      controlPlaneTenantId: CP,
      roleName: "Self Service",
    }).onExecutePostUserRegistration!(
      {
        ctx: ctx(),
        tenant: { id: CP },
        user: { user_id: userId, email_verified: true },
        request: {},
      } as any,
      {} as any,
    );

    expect(await globalRoles(CP, userId)).toEqual(["Self Service"]);
  });

  it("does not fail the sign-up when granting fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const userId = await createUser(CP, "social", true);
    const broken = {
      var: {},
      env: {
        data: {
          ...data,
          roles: {
            ...data.roles,
            list: () => Promise.reject(new Error("db down")),
          },
        },
      },
    } as any;

    await expect(
      hooks().onExecutePostUserRegistration!(
        {
          ctx: broken,
          tenant: { id: CP },
          user: { user_id: userId, email_verified: true },
          request: {},
        } as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("runs the host's own hooks after the self-service ones", async () => {
    const order: string[] = [];
    const chained = chainSelfServiceHooks(
      {
        onExecutePostUserRegistration: async () => {
          order.push("host");
        },
        onExecutePostLogin: async () => {},
      },
      {
        onExecutePostUserRegistration: async () => {
          order.push("self-service");
        },
      },
    );

    await chained.onExecutePostUserRegistration!({} as any, {} as any);

    expect(order).toEqual(["self-service", "host"]);
    expect(chained.onExecutePostLogin).toBeDefined();
  });
});
