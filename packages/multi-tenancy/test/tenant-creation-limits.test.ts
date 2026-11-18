import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import createAdapters from "@authhero/kysely-adapter";
import {
  setupMultiTenancy,
  createTenantsOpenAPIRouter,
  MultiTenancyConfig,
} from "../src/index";
import { createMigratedDb } from "./helpers/migrated-db";

const controlPlaneTenantId = "control_plane";

type TestUser = {
  sub: string;
  tenant_id: string;
  permissions?: string[];
};

const selfService: TestUser = {
  sub: "auth0|self",
  tenant_id: controlPlaneTenantId,
  permissions: ["create:tenants"],
};
const operator: TestUser = {
  sub: "auth0|operator",
  tenant_id: controlPlaneTenantId,
  permissions: ["create:tenants", "delete:tenants"],
};

describe("tenantCreationLimits", () => {
  let adapters: ReturnType<typeof createAdapters>;
  let env: { data: ReturnType<typeof createAdapters> };
  let counter = 0;

  beforeEach(async () => {
    adapters = createAdapters(await createMigratedDb());
    env = { data: adapters };
    counter = 0;
    await adapters.tenants.create({
      id: controlPlaneTenantId,
      friendly_name: "Control Plane",
      audience: "https://example.com",
      sender_email: "admin@example.com",
      sender_name: "Control Plane",
    });
    for (const u of [selfService, operator]) {
      await adapters.users.create(controlPlaneTenantId, {
        user_id: u.sub,
        email: `${u.sub.replace("|", "-")}@example.com`,
        email_verified: true,
        provider: "auth2",
        connection: "Username-Password-Authentication",
        is_social: false,
      });
    }
  });

  function appFor(
    user: TestUser,
    limits: MultiTenancyConfig["tenantCreationLimits"],
    overrides: { failReads?: boolean; failTenantReads?: boolean } = {},
  ) {
    const config: MultiTenancyConfig = {
      accessControl: {
        controlPlaneTenantId,
        requireOrganizationMatch: true,
        provisionRoles: true,
      },
      tenantCreationLimits: limits,
    };
    const { hooks } = setupMultiTenancy(config);
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", controlPlaneTenantId);
      c.set("user", user);
      await next();
    });
    app.onError((err, c) =>
      err instanceof HTTPException
        ? c.json({ message: err.message }, err.status)
        : c.json({ message: "server error" }, 500),
    );
    app.route("/management/tenants", createTenantsOpenAPIRouter(config, hooks));
    const data = overrides.failReads
      ? {
          ...adapters,
          userOrganizations: {
            ...adapters.userOrganizations,
            listUserOrganizations: async () => {
              throw new Error("db down");
            },
          },
        }
      : overrides.failTenantReads
        ? {
            ...adapters,
            tenants: {
              ...adapters.tenants,
              get: async () => {
                throw new Error("db down");
              },
            },
          }
        : adapters;
    const create = (id: string) =>
      app.request(
        "/management/tenants",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            friendly_name: id,
            audience: `https://${id}.example.com`,
            sender_email: `admin@${id}.example.com`,
            sender_name: id,
          }),
        },
        { data },
      );
    create.usage = () =>
      app.request("/management/tenants/creation-limit", {}, { data });
    return create;
  }

  const nextId = () => `tenant-${++counter}`;

  it("refuses the N+1th tenant for a self-service user, but not an operator", async () => {
    const create = appFor(selfService, { perUser: 2 });
    expect((await create(nextId())).status).toBe(201);
    expect((await create(nextId())).status).toBe(201);

    const refused = await create(nextId());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /at most 2 tenants/,
    );

    const operatorCreate = appFor(operator, { perUser: 2 });
    for (let i = 0; i < 3; i++) {
      expect((await operatorCreate(nextId())).status).toBe(201);
    }
  });

  it("reports used and limit for the caller, and where the limit comes from", async () => {
    const create = appFor(selfService, { perUser: 3 });
    expect(await (await create.usage()).json()).toEqual({
      key: "tenants_per_user",
      used: 0,
      limit: 3,
      source: "default",
    });

    expect((await create(nextId())).status).toBe(201);
    expect(await (await create.usage()).json()).toMatchObject({
      used: 1,
      limit: 3,
    });

    await adapters.users.update(controlPlaneTenantId, selfService.sub, {
      app_metadata: { tenant_limit: 10 },
    });
    expect(await (await create.usage()).json()).toMatchObject({
      used: 1,
      limit: 10,
      source: "override",
    });
  });

  it("reports no cap for an operator and when limits are unset", async () => {
    const operatorUsage = await appFor(operator, { perUser: 1 }).usage();
    expect(await operatorUsage.json()).toMatchObject({
      limit: null,
      source: "none",
    });
    const unset = await appFor(selfService, undefined).usage();
    expect(await unset.json()).toMatchObject({ limit: null, source: "none" });
  });

  it("refuses a second tenant while one is still pending", async () => {
    const create = appFor(selfService, { perUser: null });
    expect((await create("first")).status).toBe(201);
    await adapters.tenants.update("first", { provisioning_state: "pending" });

    const refused = await create(nextId());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /still being set up/,
    );

    await adapters.tenants.update("first", { provisioning_state: "ready" });
    expect((await create(nextId())).status).toBe(201);
  });

  it("lets app_metadata.tenant_limit override the configured cap", async () => {
    const create = appFor(selfService, { perUser: 1 });
    expect((await create(nextId())).status).toBe(201);
    expect((await create(nextId())).status).toBe(403);

    await adapters.users.update(controlPlaneTenantId, selfService.sub, {
      app_metadata: { tenant_limit: 3 },
    });
    expect((await create(nextId())).status).toBe(201);

    await adapters.users.update(controlPlaneTenantId, selfService.sub, {
      app_metadata: { tenant_limit: "unlimited" },
    });
    for (let i = 0; i < 3; i++) {
      expect((await create(nextId())).status).toBe(201);
    }
  });

  it("accepts a function for perUser", async () => {
    const seen: string[] = [];
    const create = appFor(selfService, {
      perUser: ({ user_id }) => {
        seen.push(user_id);
        return 1;
      },
    });
    expect((await create(nextId())).status).toBe(201);
    expect((await create(nextId())).status).toBe(403);
    expect(seen).toContain(selfService.sub);
  });

  it("fails closed with 503 when the counts cannot be read", async () => {
    const create = appFor(selfService, { perUser: 5 }, { failReads: true });
    expect((await create(nextId())).status).toBe(503);
  });

  it("skips the ownership reads when there is no cap and no pending rule", async () => {
    const create = appFor(
      selfService,
      { perUser: null, blockWhilePending: false },
      { failReads: true },
    );
    expect((await create(nextId())).status).toBe(201);
  });

  it("answers with the cap error at the cap even if tenant reads fail", async () => {
    const ok = appFor(selfService, { perUser: 1 });
    expect((await ok(nextId())).status).toBe(201);
    const create = appFor(
      selfService,
      { perUser: 1 },
      { failTenantReads: true },
    );
    const refused = await create(nextId());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /at most 1 tenant/,
    );
  });

  it("does not read provisioning state for the usage endpoint", async () => {
    const ok = appFor(selfService, { perUser: 3 });
    expect((await ok(nextId())).status).toBe(201);
    const usage = appFor(
      selfService,
      { perUser: 3 },
      { failTenantReads: true },
    );
    const res = await usage.usage();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ used: 1, limit: 3 });
  });

  it("changes nothing when tenantCreationLimits is unset", async () => {
    const create = appFor(selfService, undefined);
    for (let i = 0; i < 5; i++) {
      expect((await create(nextId())).status).toBe(201);
    }
  });

  it("does not exempt an organization-scoped token that carries operator scopes", async () => {
    const orgScoped = { ...operator, sub: selfService.sub, org_id: "org_x" };
    const create = appFor(orgScoped, { perUser: 1 });
    expect((await create(nextId())).status).toBe(201);
    expect((await create(nextId())).status).toBe(403);
  });

  it("refuses a limit when tenant roles are not managed", () => {
    expect(() =>
      setupMultiTenancy({
        accessControl: { controlPlaneTenantId },
        tenantCreationLimits: { perUser: 1 },
      }),
    ).toThrow(/managed tenant roles/);
  });

  it("refuses a limit when the creator is not added to the organization", () => {
    expect(() =>
      setupMultiTenancy({
        accessControl: {
          controlPlaneTenantId,
          provisionRoles: true,
          addCreatorToOrganization: false,
        },
        tenantCreationLimits: { perUser: 1 },
      }),
    ).toThrow(/creator added/);
  });

  it("refuses a limit when accessControl is not configured", () => {
    expect(() =>
      setupMultiTenancy({ tenantCreationLimits: { perUser: 1 } }),
    ).toThrow(/needs accessControl/);
  });

  it("refuses a limit when the control plane id is empty", () => {
    expect(() =>
      setupMultiTenancy({
        accessControl: { controlPlaneTenantId: "", provisionRoles: true },
        tenantCreationLimits: { perUser: 1 },
      }),
    ).toThrow(/needs accessControl/);
  });
});
