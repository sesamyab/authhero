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
    overrides: { failReads?: boolean } = {},
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
      : adapters;
    return (id: string) =>
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

  it("changes nothing when tenantCreationLimits is unset", async () => {
    const create = appFor(selfService, undefined);
    for (let i = 0; i < 5; i++) {
      expect((await create(nextId())).status).toBe(201);
    }
  });
});
