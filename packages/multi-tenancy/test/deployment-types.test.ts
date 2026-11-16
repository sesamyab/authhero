import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import createAdapters from "@authhero/kysely-adapter";
import {
  setupMultiTenancy,
  createTenantsOpenAPIRouter,
  MultiTenancyConfig,
} from "../src/index";
import { resolveDeploymentTypes } from "../src/utils/deployment-types";
import { createMigratedDb } from "./helpers/migrated-db";

const controlPlaneTenantId = "control_plane";

function createHostApp(config: MultiTenancyConfig) {
  const { hooks } = setupMultiTenancy(config);
  const app = new Hono<{
    Bindings: { data: ReturnType<typeof createAdapters> };
    Variables: Record<string, unknown>;
  }>();

  app.use("*", async (c, next) => {
    c.set("tenant_id", controlPlaneTenantId);
    c.set("user", {
      sub: "auth0|admin",
      tenant_id: controlPlaneTenantId,
      scope: "update:tenants",
    });
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }
    return c.json({ message: "server error" }, 500);
  });

  app.route("/tenants", createTenantsOpenAPIRouter(config, hooks));
  return app;
}

const wfpOnly: MultiTenancyConfig = {
  accessControl: { controlPlaneTenantId },
  deploymentTypes: { allowed: ["wfp"] },
};

const defaultConfig: MultiTenancyConfig = {
  accessControl: { controlPlaneTenantId },
};

describe("resolveDeploymentTypes", () => {
  it("allows both types with shared as the default when unset", () => {
    expect(resolveDeploymentTypes(undefined)).toEqual({
      allowed: ["shared", "wfp"],
      default: "shared",
    });
  });

  it("defaults to the first allowed type", () => {
    expect(resolveDeploymentTypes({ allowed: ["wfp", "shared"] })).toEqual({
      allowed: ["wfp", "shared"],
      default: "wfp",
    });
  });

  it("refuses an empty list", () => {
    expect(() => resolveDeploymentTypes({ allowed: [] })).toThrow();
  });

  it("refuses a default that is not allowed", () => {
    expect(() =>
      resolveDeploymentTypes({ allowed: ["wfp"], default: "shared" }),
    ).toThrow();
  });
});

describe("tenant deployment types", () => {
  let adapters: ReturnType<typeof createAdapters>;
  let env: { data: ReturnType<typeof createAdapters> };

  beforeEach(async () => {
    const db = await createMigratedDb();
    adapters = createAdapters(db);
    env = { data: adapters };
    await adapters.tenants.create({
      id: controlPlaneTenantId,
      friendly_name: "Control Plane",
      audience: "https://example.com",
      sender_email: "admin@example.com",
      sender_name: "Control Plane",
    });
  });

  function createTenant(
    app: ReturnType<typeof createHostApp>,
    body: Record<string, unknown>,
  ) {
    return app.request(
      "/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendly_name: "New tenant", ...body }),
      },
      env,
    );
  }

  it("serves the configured options", async () => {
    const response = await createHostApp(wfpOnly).request(
      "/tenants/deployment-options",
      {},
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deployment_types: ["wfp"],
      default_deployment_type: "wfp",
    });
  });

  it("serves both types when nothing is configured", async () => {
    const response = await createHostApp(defaultConfig).request(
      "/tenants/deployment-options",
      {},
      env,
    );
    expect(await response.json()).toEqual({
      deployment_types: ["shared", "wfp"],
      default_deployment_type: "shared",
    });
  });

  it("serves the tenant host template when one is configured", async () => {
    const response = await createHostApp({
      ...wfpOnly,
      tenantHostTemplate: "{id}.auth.example.com",
    }).request("/tenants/deployment-options", {}, env);
    expect(await response.json()).toEqual({
      deployment_types: ["wfp"],
      default_deployment_type: "wfp",
      tenant_host_template: "{id}.auth.example.com",
    });
  });

  it("creates a wfp tenant with its own D1 when the type is omitted on a wfp-only cluster", async () => {
    const response = await createTenant(createHostApp(wfpOnly), {
      id: "omitted",
    });
    expect(response.status).toBe(201);
    const tenant = await adapters.tenants.get("omitted");
    expect(tenant?.deployment_type).toBe("wfp");
    expect(tenant?.storage_kind).toBe("own_d1");
  });

  it("keeps a storage kind the caller names", async () => {
    const response = await createTenant(createHostApp(wfpOnly), {
      id: "existing-d1",
      storage_kind: "existing_d1",
    });
    expect(response.status).toBe(201);
    expect((await adapters.tenants.get("existing-d1"))?.storage_kind).toBe(
      "existing_d1",
    );
  });

  it("refuses a shared tenant on a wfp-only cluster", async () => {
    const response = await createTenant(createHostApp(wfpOnly), {
      id: "shared-one",
      deployment_type: "shared",
    });
    expect(response.status).toBe(400);
    expect(await adapters.tenants.get("shared-one")).toBeNull();
  });

  it("still creates a shared tenant by default when nothing is configured", async () => {
    const response = await createTenant(createHostApp(defaultConfig), {
      id: "plain",
    });
    expect(response.status).toBe(201);
    const tenant = await adapters.tenants.get("plain");
    expect(tenant?.deployment_type).toBe("shared");
    expect(tenant?.storage_kind).toBeUndefined();
  });

  it("refuses moving a tenant onto a type the cluster can't host", async () => {
    await adapters.tenants.update(controlPlaneTenantId, {
      deployment_type: "wfp",
    });
    const response = await createHostApp(wfpOnly).request(
      "/tenants/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployment_type: "shared" }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(
      (await adapters.tenants.get(controlPlaneTenantId))?.deployment_type,
    ).toBe("wfp");
  });

  it("accepts an unchanged type from the whole record the admin UI sends", async () => {
    // The control plane itself is shared, which a wfp-only cluster no longer
    // offers for new tenants.
    await adapters.tenants.update(controlPlaneTenantId, {
      deployment_type: "shared",
    });
    const response = await createHostApp(wfpOnly).request(
      "/tenants/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deployment_type: "shared",
          friendly_name: "Renamed",
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
  });
});
