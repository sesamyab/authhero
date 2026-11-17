import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import createAdapters from "@authhero/kysely-adapter";
import { MANAGEMENT_API_AUDIENCE } from "authhero";
import { setupMultiTenancy } from "../src/index";
import { createSelfServiceSignupHooks } from "../src/hooks/self-service-signup";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";

/**
 * The self-service path from sign-up to a created tenant: a verified user is
 * granted the role, what that role carries is exactly `create:tenants`, and a
 * user holding only that can create a tenant and ends up admin of its
 * organization.
 *
 * Scope enforcement (403 without `create:tenants`) lives in authhero's
 * management API middleware, not in this package's router, so the request here
 * carries the scopes the role grants and the test checks what they are.
 */
describe("self-service sign-up to a created tenant", () => {
  let data: ReturnType<typeof createAdapters>;
  let env: { data: ReturnType<typeof createAdapters> };

  beforeEach(async () => {
    data = createAdapters(await createMigratedDb());
    env = { data };
    await data.tenants.create({
      id: CP,
      friendly_name: "Control Plane",
      audience: "https://example.com",
      sender_email: "admin@example.com",
      sender_name: "Control Plane",
    });
  });

  /** A user's global permissions, as the token's `permissions` claim carries them. */
  async function globalPermissions(userId: string) {
    const roles = await data.userRoles.list(CP, userId, undefined, "");
    const permissions: string[] = [];
    for (const role of roles) {
      const granted = await data.rolePermissions.list(CP, role.id, {
        per_page: 1000,
      });
      for (const permission of granted) {
        expect(permission.resource_server_identifier).toBe(
          MANAGEMENT_API_AUDIENCE,
        );
        permissions.push(permission.permission_name);
      }
    }
    return permissions;
  }

  function appFor(userId: string, permissions: string[]) {
    const multiTenancy = setupMultiTenancy({
      accessControl: {
        controlPlaneTenantId: CP,
        requireOrganizationMatch: false,
        issuer: "https://auth.example.com/",
      },
    });
    const app = new Hono<{
      Bindings: { data: ReturnType<typeof createAdapters> };
      Variables: Record<string, unknown>;
    }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", CP);
      c.set("user", {
        sub: userId,
        tenant_id: CP,
        permissions,
        scope: permissions.join(" "),
      });
      await next();
    });
    app.use("*", multiTenancy.middleware);
    app.route("/management", multiTenancy.app);
    return app;
  }

  it("lets a verified sign-up create a tenant and become its admin", async () => {
    const userId = "auth2|newcomer";
    await data.users.create(CP, {
      user_id: userId,
      email: "newcomer@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });

    // 1. Sign-up: the post-registration hook grants the role.
    await createSelfServiceSignupHooks({
      controlPlaneTenantId: CP,
    }).onExecutePostUserRegistration!(
      {
        ctx: { var: {}, env },
        tenant: { id: CP },
        user: { user_id: userId, email_verified: true },
        request: {},
      } as any,
      {} as any,
    );

    // 2. The permissions a token would carry: the self-service set, nothing
    // else (no read:tenants, delete:tenants, admin:organizations, rollouts).
    const permissions = await globalPermissions(userId);
    expect([...permissions].sort()).toEqual([
      "create:tenants",
      "read:tenant_operations",
      "retry:tenant_provisioning",
    ]);

    // 3. A user holding only that creates a tenant.
    const response = await appFor(userId, permissions).request(
      "/management/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "acme",
          friendly_name: "Acme",
          audience: "https://acme.example.com",
          sender_email: "support@acme.example.com",
          sender_name: "Acme",
        }),
      },
      env,
    );
    expect(response.status).toBe(201);

    // 4. They are a member of the tenant's organization with the owner role.
    const { organizations } = await data.organizations.list(CP);
    const org = organizations.find((o) => o.name === "acme")!;
    expect(org).toBeDefined();
    const memberships = await data.userOrganizations.listUserOrganizations(
      CP,
      userId,
    );
    expect(memberships.organizations.map((o) => o.name)).toContain("acme");
    const orgRoles = await data.userRoles.list(CP, userId, undefined, org.id);
    // A self-service creator gets the owner role, not the operators' admin role.
    expect(orgRoles.map((role) => role.name)).toEqual(["Tenant Owner"]);

    // The global role is unchanged by creating a tenant.
    expect([...(await globalPermissions(userId))].sort()).toEqual([
      "create:tenants",
      "read:tenant_operations",
      "retry:tenant_provisioning",
    ]);
  });
});
