import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import { seedTenant } from "../../helpers/seed-tenant";

// The settings payloads themselves are covered by settings.spec.ts; this file
// covers the parts of the tenants module around them — the `is_control_plane`
// flag the routes add to every response, and the missing-tenant path.
describe("management-api tenants", () => {
  async function setup() {
    const { app, managementApp, env } = await getTestServer();
    return {
      app,
      env,
      managementClient: testClient(managementApp, env),
      token: await getAdminToken(),
    };
  }

  describe("GET /api/v2/tenants/settings", () => {
    it("marks the tenant as the control plane when no control plane is configured", async () => {
      const { managementClient, token } = await setup();

      const response = await managementClient.tenants.settings.$get(
        { header: { "tenant-id": "tenantId" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        id: "tenantId",
        is_control_plane: true,
      });
    });

    it("marks the tenant as not the control plane when another tenant is", async () => {
      const { env, managementClient, token } = await setup();
      env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };

      const response = await managementClient.tenants.settings.$get(
        { header: { "tenant-id": "tenantId" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "tenantId",
        is_control_plane: false,
      });
    });

    describe("has_children", () => {
      const get = async (
        ctx: Awaited<ReturnType<typeof setup>>,
        tenantId: string,
      ) =>
        (
          await ctx.managementClient.tenants.settings.$get(
            { header: { "tenant-id": tenantId } },
            { headers: { authorization: `Bearer ${ctx.token}` } },
          )
        ).json();

      it("is false for a lone control plane", async () => {
        const ctx = await setup();
        expect(await get(ctx, "tenantId")).toMatchObject({
          is_control_plane: true,
          has_children: false,
        });
      });

      it("is true for the control plane once another tenant exists", async () => {
        const ctx = await setup();
        ctx.env.data.multiTenancyConfig = { controlPlaneTenantId: "tenantId" };
        await seedTenant(ctx.env.data, "child");

        expect(await get(ctx, "tenantId")).toMatchObject({
          has_children: true,
        });
      });

      it("is true only for a tenant that another tenant names as its parent", async () => {
        const ctx = await setup();
        ctx.env.data.multiTenancyConfig = { controlPlaneTenantId: "tenantId" };
        await seedTenant(ctx.env.data, "partner");
        await seedTenant(ctx.env.data, "leaf");
        await seedTenant(ctx.env.data, "other");
        await ctx.env.data.tenants.update("leaf", {
          parent_tenant_id: "partner",
        });

        expect(await get(ctx, "partner")).toMatchObject({ has_children: true });
        expect(await get(ctx, "leaf")).toMatchObject({ has_children: false });
        expect(await get(ctx, "other")).toMatchObject({ has_children: false });
      });

      it("matches a parent id with spaces or query syntax literally", async () => {
        const ctx = await setup();
        ctx.env.data.multiTenancyConfig = { controlPlaneTenantId: "tenantId" };
        await seedTenant(ctx.env.data, "odd partner OR other");
        await seedTenant(ctx.env.data, "leaf");
        await seedTenant(ctx.env.data, "other");
        await ctx.env.data.tenants.update("leaf", {
          parent_tenant_id: "odd partner OR other",
        });

        expect(await get(ctx, "odd partner OR other")).toMatchObject({
          has_children: true,
        });
        expect(await get(ctx, "other")).toMatchObject({ has_children: false });
      });
    });

    it("returns the settings of the tenant named by the header, not another tenant's", async () => {
      const { env, managementClient, token } = await setup();
      await seedTenant(env.data, "otherTenant");
      await env.data.tenants.update("otherTenant", {
        friendly_name: "Other Tenant",
      });

      const response = await managementClient.tenants.settings.$get(
        { header: { "tenant-id": "otherTenant" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "otherTenant",
        friendly_name: "Other Tenant",
      });
    });

    it("returns 404 when the tenant does not exist", async () => {
      const { managementClient, token } = await setup();

      const response = await managementClient.tenants.settings.$get(
        { header: { "tenant-id": "does-not-exist" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /api/v2/tenants/settings", () => {
    it("carries the control-plane flag on the updated settings", async () => {
      const { env, managementClient, token } = await setup();
      env.data.multiTenancyConfig = { controlPlaneTenantId: "tenantId" };

      const response = await managementClient.tenants.settings.$patch(
        {
          json: { friendly_name: "Renamed Tenant" },
          header: { "tenant-id": "tenantId" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        friendly_name: "Renamed Tenant",
        is_control_plane: true,
      });
    });

    describe("config_sync", () => {
      it("lets a control-plane token switch a tenant to synced and back", async () => {
        const { env, managementClient } = await setup();
        env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };
        const token = await getAdminToken({ tenant_id: "control_plane" });

        const flip = await managementClient.tenants.settings.$patch(
          {
            json: { config_sync: "synced" },
            header: { "tenant-id": "tenantId" },
          },
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(flip.status).toBe(200);
        expect((await env.data.tenants.get("tenantId"))?.config_sync).toBe(
          "synced",
        );

        const back = await managementClient.tenants.settings.$patch(
          {
            json: { config_sync: "inherit-on-read" },
            header: { "tenant-id": "tenantId" },
          },
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(back.status).toBe(200);
        expect((await env.data.tenants.get("tenantId"))?.config_sync).toBe(
          "inherit-on-read",
        );
      });

      it("rejects a change from the tenant's own admin", async () => {
        const { env, managementClient } = await setup();
        env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };
        const token = await getAdminToken({ tenant_id: "tenantId" });

        const response = await managementClient.tenants.settings.$patch(
          {
            json: { config_sync: "synced" },
            header: { "tenant-id": "tenantId" },
          },
          { headers: { authorization: `Bearer ${token}` } },
        );

        expect(response.status).toBe(403);
        expect(
          (await env.data.tenants.get("tenantId"))?.config_sync,
        ).toBeUndefined();
      });

      it("accepts an unchanged value from the tenant's own admin", async () => {
        const { env, managementClient } = await setup();
        env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };
        const token = await getAdminToken({ tenant_id: "tenantId" });

        const response = await managementClient.tenants.settings.$patch(
          {
            json: {
              config_sync: "inherit-on-read",
              friendly_name: "Renamed",
            },
            header: { "tenant-id": "tenantId" },
          },
          { headers: { authorization: `Bearer ${token}` } },
        );

        expect(response.status).toBe(200);
      });

      it("allows the change in a deployment without a control plane", async () => {
        const { env, managementClient, token } = await setup();

        const response = await managementClient.tenants.settings.$patch(
          {
            json: { config_sync: "synced" },
            header: { "tenant-id": "tenantId" },
          },
          { headers: { authorization: `Bearer ${token}` } },
        );

        expect(response.status).toBe(200);
        expect((await env.data.tenants.get("tenantId"))?.config_sync).toBe(
          "synced",
        );
      });
    });

    it("ignores an id in the body instead of renaming the tenant", async () => {
      const { env, managementClient, token } = await setup();

      const response = await managementClient.tenants.settings.$patch(
        {
          json: { id: "hijacked", friendly_name: "Renamed Tenant" },
          header: { "tenant-id": "tenantId" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "tenantId",
        friendly_name: "Renamed Tenant",
      });
      expect(await env.data.tenants.get("hijacked")).toBeNull();
    });

    it("does not accept database_version, which the provisioner owns", async () => {
      const { app, env, token } = await setup();
      const before = await env.data.tenants.get("tenantId");

      const response = await app.request(
        "/api/v2/tenants/settings",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "tenant-id": "tenantId",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ database_version: "0099_hijack.sql" }),
        },
        env,
      );

      expect(response.status).toBe(200);
      const tenant = await env.data.tenants.get("tenantId");
      expect(tenant?.database_version).toBe(before?.database_version);
    });

    it("returns 404 when the tenant does not exist", async () => {
      const { managementClient, token } = await setup();

      const response = await managementClient.tenants.settings.$patch(
        {
          json: { friendly_name: "Renamed Tenant" },
          header: { "tenant-id": "does-not-exist" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });
  });
});
