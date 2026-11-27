import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import createAdapters from "@authhero/kysely-adapter";
import {
  setupMultiTenancy,
  MANAGEMENT_API_SCOPES,
  buildControlPlaneDefaultsPayload,
  applyControlPlaneDefaultsPayload,
} from "../src/index";
import { applyTenantDefaults } from "../src/hooks/provisioning";
import { ADMIN_REQUIRES_SCOPES } from "../src/hooks/tenant-roles";
import { USERNAME_PASSWORD_PROVIDER } from "../../authhero/src/constants";
import { createMigratedDb } from "./helpers/migrated-db";

const USER_ID = "auth0|operator";

describe("applyTenantDefaults", () => {
  it("lets the request win and merges nested objects key by key", () => {
    const result = applyTenantDefaults(
      { friendly_name: "T", flags: { enable_sso: false } },
      {
        flags: { enable_sso: true, disable_impersonation: true },
        mfa: { policy: "confidence" },
      },
    );
    expect(result.flags).toEqual({
      enable_sso: false,
      disable_impersonation: true,
    });
    expect(result.mfa).toEqual({ policy: "confidence" });
  });

  it("ignores identity and sync fields in the defaults at runtime", () => {
    const defaults = {
      audience: "https://shared.example.com",
      config_sync: "synced",
      flags: { enable_sso: true },
    } as unknown as Parameters<typeof applyTenantDefaults>[1];

    const without = applyTenantDefaults({ friendly_name: "T" }, defaults);
    expect(without.audience).toBeUndefined();
    expect(without.config_sync).toBeUndefined();
    expect(without.flags).toEqual({ enable_sso: true });

    const own = applyTenantDefaults(
      { friendly_name: "T", audience: "https://own.example.com" },
      defaults,
    );
    expect(own.audience).toBe("https://own.example.com");
  });

  it("keeps a null the request sets", () => {
    const result = applyTenantDefaults(
      { friendly_name: "T", sender_email: null },
      { sender_email: "default@example.com" },
    );
    expect(result.sender_email).toBeNull();
  });
});

describe("tenantDefaults on POST /tenants", () => {
  let adapters: ReturnType<typeof createAdapters>;

  async function createApp(
    tenantDefaults: Parameters<typeof setupMultiTenancy>[0]["tenantDefaults"],
    config: Partial<Parameters<typeof setupMultiTenancy>[0]> = {},
  ) {
    const db = await createMigratedDb();
    adapters = createAdapters(db);
    await adapters.tenants.create({
      id: "control_plane",
      friendly_name: "Control Plane",
      audience: "https://example.com",
      sender_email: "admin@example.com",
      sender_name: "Control Plane",
    });
    await adapters.resourceServers.create("control_plane", {
      name: "Authhero Management API",
      identifier: "urn:authhero:management",
      allow_offline_access: false,
      skip_consent_for_verifiable_first_party_clients: false,
      token_lifetime: 86400,
      token_lifetime_for_web: 7200,
      signing_alg: "RS256",
      scopes: MANAGEMENT_API_SCOPES,
    });
    await adapters.users.create("control_plane", {
      user_id: USER_ID,
      email: "operator@example.com",
      email_verified: true,
      connection: "Username-Password-Authentication",
      provider: USERNAME_PASSWORD_PROVIDER,
    });
    const role = await adapters.roles.create("control_plane", {
      name: "Operator",
    });
    await adapters.rolePermissions.assign(
      "control_plane",
      role.id,
      ADMIN_REQUIRES_SCOPES.map((permission_name) => ({
        role_id: role.id,
        resource_server_identifier: "urn:authhero:management",
        permission_name,
      })),
    );
    await adapters.userRoles.create("control_plane", USER_ID, role.id, "");
    const multiTenancy = setupMultiTenancy({
      accessControl: {
        controlPlaneTenantId: "control_plane",
        requireOrganizationMatch: false,
      },
      tenantDefaults,
      ...config,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "control_plane");
      c.set("user", { sub: USER_ID, tenant_id: "control_plane" });
      await next();
    });
    app.use("*", multiTenancy.middleware);
    app.route("/management", multiTenancy.app);
    return app;
  }

  const create = (app: Hono, id: string, extra: object = {}) =>
    app.request(
      "/management/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, friendly_name: id, ...extra }),
      },
      { data: adapters },
    );

  it("copies the defaults onto a new tenant, which can then change them", async () => {
    const app = await createApp({
      mfa: { policy: "confidence" },
      flags: { disable_impersonation: true },
    });
    expect((await create(app, "t1")).status).toBe(201);

    const tenant = await adapters.tenants.get("t1");
    expect(tenant?.mfa?.policy).toBe("confidence");
    expect(tenant?.flags?.disable_impersonation).toBe(true);
    // New tenants get the widget login (#1741), next to the defaults.
    expect(tenant?.flags?.universal_login_version).toBe("2");

    // A new tenant's default client logs in through v2.
    const { clients } = await adapters.clients.list("t1");
    expect(
      clients.some((c) => c.client_metadata?.universal_login_version === "2"),
    ).toBe(true);

    await adapters.tenants.update("t1", { mfa: { policy: "never" } });
    expect((await adapters.tenants.get("t1"))?.mfa?.policy).toBe("never");
  });

  it("does not touch tenants that already exist", async () => {
    const app = await createApp({ mfa: { policy: "confidence" } });
    expect((await create(app, "later")).status).toBe(201);
    expect((await adapters.tenants.get("later"))?.mfa?.policy).toBe(
      "confidence",
    );
    expect((await adapters.tenants.get("control_plane"))?.mfa?.policy).not.toBe(
      "confidence",
    );
  });

  it("lets the request override a default and accepts a function", async () => {
    const app = await createApp((params) => ({
      flags: { enable_sso: params.friendly_name === "t2" },
    }));
    await create(app, "t2");
    await create(app, "t3", { flags: { enable_sso: true } });
    expect((await adapters.tenants.get("t2"))?.flags?.enable_sso).toBe(true);
    expect((await adapters.tenants.get("t3"))?.flags?.enable_sso).toBe(true);
  });

  it("reaches a tenant with its own database through the provisioning seed", async () => {
    // The tenant's own database starts empty, like a freshly migrated wfp D1.
    // The provision step seeds it from the control plane's copy of the row,
    // which is where `tenantDefaults` were applied.
    const tenantDb = createAdapters(await createMigratedDb());
    const app = await createApp(
      {
        idle_session_lifetime: 72,
        session_lifetime: 168,
        mfa: { policy: "confidence" },
      },
      {
        databaseIsolation: {
          getAdapters: async (tenantId) =>
            tenantId === "control_plane" ? adapters : tenantDb,
          onProvision: async (tenantId) => {
            const payload = await buildControlPlaneDefaultsPayload(
              adapters,
              "control_plane",
              {},
              tenantId,
            );
            await applyControlPlaneDefaultsPayload(
              payload,
              tenantDb,
              "control_plane",
            );
          },
        },
      },
    );
    expect((await create(app, "wfp1")).status).toBe(201);

    const own = await tenantDb.tenants.get("wfp1");
    expect(own?.idle_session_lifetime).toBe(72);
    expect(own?.session_lifetime).toBe(168);
    expect(own?.mfa?.policy).toBe("confidence");
    // Identity / deployment fields stay on the control plane.
    expect(own?.audience).toBeFalsy();

    // The control plane's own row in the tenant DB stays minimal.
    const cp = await tenantDb.tenants.get("control_plane");
    expect(cp?.friendly_name).toBe("Control Plane");
    expect(cp?.sender_email).toBeFalsy();
  });
});
