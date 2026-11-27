import { describe, expect, it } from "vitest";
import { getTestServer } from "./test-server";
import {
  auditLoginMigration,
  setTenantLoginVersion,
} from "../../src/helpers/login-migration";

describe("login migration tooling", () => {
  it("audits a tenant on /u", async () => {
    const { env } = await getTestServer();
    const report = await auditLoginMigration(env.data, "tenantId");

    expect(report.tenant_version).toBeUndefined();
    expect(report.unmigrated).toBe(report.clients.length);
    expect(report.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["tenant_setting", "theme", "terms_url"]),
    );
    expect(report.checks.find((c) => c.id === "tenant_setting")?.status).toBe(
      "warn",
    );
  });

  it("flips a tenant, keeps other flags and client overrides, and rolls back", async () => {
    const { env } = await getTestServer();
    await env.data.tenants.update("tenantId", {
      flags: { enable_sso: true },
    });
    await env.data.clients.update("tenantId", "clientId", {
      client_metadata: { universal_login_version: "1" },
    });

    const dry = await setTenantLoginVersion(env.data, "tenantId", "2", {
      dryRun: true,
    });
    expect(dry.pinned).toEqual(["clientId"]);
    expect(
      (await env.data.tenants.get("tenantId"))?.flags?.universal_login_version,
    ).toBeUndefined();

    await setTenantLoginVersion(env.data, "tenantId", "2");
    let tenant = await env.data.tenants.get("tenantId");
    expect(tenant?.flags).toMatchObject({
      enable_sso: true,
      universal_login_version: "2",
    });
    const report = await auditLoginMigration(env.data, "tenantId");
    expect(report.clients.find((c) => c.client_id === "clientId")?.prefix).toBe(
      "/u",
    );
    expect(report.unmigrated).toBe(1);
    expect(
      (await env.data.clients.get("tenantId", "clientId"))?.client_metadata,
    ).toEqual({ universal_login_version: "1" });

    await setTenantLoginVersion(env.data, "tenantId", undefined);
    tenant = await env.data.tenants.get("tenantId");
    expect(tenant?.flags?.universal_login_version).toBeUndefined();
    expect(tenant?.flags?.enable_sso).toBe(true);
  });
});
