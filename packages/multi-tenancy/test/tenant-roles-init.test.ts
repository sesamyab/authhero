import { beforeEach, describe, expect, it, vi } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import { encodeBase64Url } from "@authhero/adapter-interfaces";
import { init, MANAGEMENT_API_AUDIENCE, MANAGEMENT_API_SCOPES } from "authhero";
import { initMultiTenant } from "../src/init";
import { createProvisioningHooks } from "../src/hooks/provisioning";
import {
  ADMIN_REQUIRES_SCOPES,
  OPERATOR_ONLY_SCOPES,
  tenantOwnerScopes,
} from "../src/hooks/tenant-roles";
import { DEFAULT_SELF_SERVICE_ROLE_NAME } from "../src/hooks/self-service-signup";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const ISSUER = "https://auth.example.com/";

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

async function signRs256(
  pkcs8Pem: string,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * What a creator can do in their new tenant is decided by the role they get in
 * its organization. Through `initMultiTenant` that role used to not exist at
 * all (the provisioning hook was built without an issuer), so these go through
 * the real app.
 */
describe("the role a tenant's creator gets, through initMultiTenant", () => {
  let data: ReturnType<typeof createAdapters>;
  let createTenant: (userId: string, id: string) => Promise<Response>;

  const roleNames = async (userId: string, organizationId: string) =>
    (await data.userRoles.list(CP, userId, undefined, organizationId))
      .map((role) => role.name)
      .sort();

  const orgOf = async (tenantId: string) =>
    (await data.organizations.list(CP)).organizations.find(
      (org) => org.name === tenantId,
    )!;

  const permissionsOf = async (roleName: string) => {
    const role = (await data.roles.list(CP, {})).roles.find(
      (r) => r.name === roleName,
    )!;
    return (await data.rolePermissions.list(CP, role.id, { per_page: 1000 }))
      .map((p) => p.permission_name)
      .sort();
  };

  const newUser = (id: string) =>
    data.users.create(CP, {
      user_id: id,
      email: `${id.replace("|", "-")}@example.com`,
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });

  /** A user who holds the operator scopes globally, through a role. */
  const makeOperator = async (id: string, scopes = ADMIN_REQUIRES_SCOPES) => {
    await newUser(id);
    const role = await data.roles.create(CP, { name: `ops-${id}` });
    await data.rolePermissions.assign(
      CP,
      role.id,
      scopes.map((permission_name) => ({
        role_id: role.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name,
      })),
    );
    await data.userRoles.create(CP, id, role.id, "");
  };

  beforeEach(async () => {
    data = createAdapters(await createMigratedDb());
    await data.tenants.create({
      id: CP,
      friendly_name: CP,
      audience: "https://control-plane.example.com",
      sender_email: "admin@example.com",
      sender_name: CP,
    });
    const { createX509Certificate } = init({ dataAdapter: data });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await data.keys.create({ ...signingKey, type: "jwt_signing" });

    const { app } = initMultiTenant({
      dataAdapter: data,
      controlPlane: { tenantId: CP, clientId: "control-plane-client" },
    });
    const env = {
      ISSUER,
      AUTH_URL: "https://auth.example.com",
      ENVIRONMENT: "test",
    };
    createTenant = async (userId, id) => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
        iss: ISSUER,
        aud: MANAGEMENT_API_AUDIENCE,
        sub: userId,
        tenant_id: CP,
        permissions: ["create:tenants"],
        iat: now,
        exp: now + 3600,
      });
      return app.request(
        "/api/v2/tenants",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": CP,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id, friendly_name: id }),
        },
        env,
      );
    };
  });

  it("gives a creator who holds the operator scopes the Tenant Admin role with every management scope", async () => {
    await makeOperator("auth2|operator");
    const response = await createTenant("auth2|operator", "acme");
    expect(response.status).toBe(201);

    const org = await orgOf("acme");
    expect(await roleNames("auth2|operator", org.id)).toEqual(["Tenant Admin"]);
    expect(await permissionsOf("Tenant Admin")).toEqual(
      MANAGEMENT_API_SCOPES.map((scope) => scope.value).sort(),
    );
  });

  it("gives a creator without the operator scopes the Owner role, whichever way they got create:tenants", async () => {
    // A direct permission, a custom role with only create:tenants, and an
    // operator who lacks one of the scopes: none of them holds what the admin
    // role would add, so none of them gets it.
    await newUser("auth2|direct");
    await data.userPermissions.create(CP, "auth2|direct", {
      resource_server_identifier: MANAGEMENT_API_AUDIENCE,
      permission_name: "create:tenants",
    });
    await newUser("auth2|custom");
    const custom = await data.roles.create(CP, { name: "Creators" });
    await data.rolePermissions.assign(CP, custom.id, [
      {
        role_id: custom.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: "create:tenants",
      },
    ]);
    await data.userRoles.create(CP, "auth2|custom", custom.id, "");
    await makeOperator(
      "auth2|partial",
      ADMIN_REQUIRES_SCOPES.filter((scope) => scope !== "delete:tenants"),
    );

    for (const id of ["direct", "custom", "partial"]) {
      expect((await createTenant(`auth2|${id}`, `t-${id}`)).status).toBe(201);
      const org = await orgOf(`t-${id}`);
      expect(await roleNames(`auth2|${id}`, org.id)).toEqual(["Tenant Owner"]);
    }
  });

  it("gives a self-service creator the Tenant Owner role, without the operator-only scopes", async () => {
    await newUser("auth2|customer");
    const creator = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.userRoles.create(CP, "auth2|customer", creator.id, "");

    const response = await createTenant("auth2|customer", "globex");
    expect(response.status).toBe(201);

    const org = await orgOf("globex");
    expect(await roleNames("auth2|customer", org.id)).toEqual(["Tenant Owner"]);
    const owner = await permissionsOf("Tenant Owner");
    expect(owner).toEqual([...tenantOwnerScopes()].sort());
    for (const scope of OPERATOR_ONLY_SCOPES) {
      expect(owner).not.toContain(scope);
    }
    // The owner can do what the getting-started checklist asks for.
    expect(owner).toEqual(
      expect.arrayContaining([
        "create:clients",
        "create:users",
        "update:branding",
        "read:logs",
      ]),
    );
  });

  it("tops up an existing Tenant Admin role with scopes added since it was created", async () => {
    await makeOperator("auth2|operator");
    const role = await data.roles.create(CP, { name: "Tenant Admin" });
    await data.rolePermissions.assign(CP, role.id, [
      {
        role_id: role.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: "read:users",
      },
      {
        role_id: role.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: "custom:permission",
      },
    ]);

    const response = await createTenant("auth2|operator", "acme");
    expect(response.status).toBe(201);

    const permissions = await permissionsOf("Tenant Admin");
    expect(permissions).toEqual(
      [
        ...MANAGEMENT_API_SCOPES.map((scope) => scope.value),
        "custom:permission",
      ].sort(),
    );
    const roles = (await data.roles.list(CP, {})).roles.filter(
      (r) => r.name === "Tenant Admin",
    );
    expect(roles).toHaveLength(1);
  });

  it("refuses an owner role named like the admin role", () => {
    expect(() =>
      createProvisioningHooks({
        accessControl: {
          controlPlaneTenantId: CP,
          ownerRoleName: "Tenant Admin",
        },
      }),
    ).toThrow(/must differ/);
    expect(() =>
      createProvisioningHooks({
        accessControl: {
          controlPlaneTenantId: CP,
          adminRoleName: "Owners",
          ownerRoleName: "Owners",
        },
      }),
    ).toThrow(/must differ/);
  });

  it("creates nothing when the creator's role cannot be resolved", async () => {
    await newUser("auth2|customer");
    const creator = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.userRoles.create(CP, "auth2|customer", creator.id, "");
    // Creating the owner role fails, as a db error would.
    const create = data.roles.create.bind(data.roles);
    data.roles.create = (async (...args: Parameters<typeof create>) => {
      if (args[1].name === "Tenant Owner") throw new Error("db down");
      return create(...args);
    }) as typeof create;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await createTenant("auth2|customer", "globex");

    expect(response.status).not.toBe(201);
    // Nothing is left behind, so the same id can be retried: no tenant row, no
    // organization, no membership.
    expect(await data.tenants.get("globex")).toBeNull();
    expect(
      (await data.organizations.list(CP)).organizations.map((o) => o.name),
    ).not.toContain("globex");
    expect(
      (await data.userOrganizations.listUserOrganizations(CP, "auth2|customer"))
        .organizations,
    ).toEqual([]);

    // And once the failure is gone the retry succeeds.
    data.roles.create = create;
    expect((await createTenant("auth2|customer", "globex")).status).toBe(201);
    error.mockRestore();
  });

  it("resolves the creator's roles once, so nothing that can fail runs after the tenant row exists", async () => {
    await newUser("auth2|customer");
    const creator = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.userRoles.create(CP, "auth2|customer", creator.id, "");
    // Once the tenant row is written, reading roles fails: a second resolution
    // there would leave the tenant behind with no organization.
    let tenantWritten = false;
    const createTenantRow = data.tenants.create.bind(data.tenants);
    data.tenants.create = (async (
      ...args: Parameters<typeof createTenantRow>
    ) => {
      const tenant = await createTenantRow(...args);
      tenantWritten = true;
      return tenant;
    }) as typeof createTenantRow;
    const list = data.roles.list.bind(data.roles);
    data.roles.list = (async (...args: Parameters<typeof list>) => {
      if (tenantWritten) throw new Error("db down");
      return list(...args);
    }) as typeof list;

    const response = await createTenant("auth2|customer", "globex");

    expect(response.status).toBe(201);
    const org = (await data.organizations.list(CP)).organizations.find(
      (o) => o.name === "globex",
    )!;
    expect(await roleNames("auth2|customer", org.id)).toEqual(["Tenant Owner"]);
  });

  it("reads nothing about the creator after the tenant row exists, including the global admin check", async () => {
    await newUser("auth2|customer");
    const creator = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.userRoles.create(CP, "auth2|customer", creator.id, "");
    // Once the tenant row is written, every read the creator's membership
    // depends on fails: roles, the creator's roles and their permissions.
    let tenantWritten = false;
    const createTenantRow = data.tenants.create.bind(data.tenants);
    data.tenants.create = (async (
      ...args: Parameters<typeof createTenantRow>
    ) => {
      const tenant = await createTenantRow(...args);
      tenantWritten = true;
      return tenant;
    }) as typeof createTenantRow;
    const guard = <T extends (...args: never[]) => Promise<unknown>>(fn: T) =>
      (async (...args: Parameters<T>) => {
        if (tenantWritten) throw new Error("db down");
        return fn(...args);
      }) as unknown as T;
    data.roles.list = guard(data.roles.list.bind(data.roles));
    data.userRoles.list = guard(data.userRoles.list.bind(data.userRoles));
    data.rolePermissions.list = guard(
      data.rolePermissions.list.bind(data.rolePermissions),
    );

    const response = await createTenant("auth2|customer", "globex");

    expect(response.status).toBe(201);
    tenantWritten = false;
    const org = (await data.organizations.list(CP)).organizations.find(
      (o) => o.name === "globex",
    )!;
    expect(await roleNames("auth2|customer", org.id)).toEqual(["Tenant Owner"]);
  });

  it("leaves an earlier creator on the role they already have", async () => {
    await makeOperator("auth2|early");
    await createTenant("auth2|early", "first");
    const firstOrg = await orgOf("first");

    await newUser("auth2|customer");
    const creator = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    await data.userRoles.create(CP, "auth2|customer", creator.id, "");
    await createTenant("auth2|customer", "second");

    expect(await roleNames("auth2|early", firstOrg.id)).toEqual([
      "Tenant Admin",
    ]);
  });
});
