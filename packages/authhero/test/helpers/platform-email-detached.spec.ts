import { describe, it, expect } from "vitest";
import { getTestServer } from "./test-server";
import { seedTenant } from "./seed-tenant";
import { withPlatformRowsHidden } from "../../src/helpers/platform-rows";

// A platform-scoped email provider is a copy delivered by a sync. It stays
// hidden from the tenant's admins when the tenant leaves its parent.
describe("platform email provider after a detach", () => {
  async function setup(configSync?: "synced" | "detached") {
    const { env } = await getTestServer();
    await seedTenant(env.data, "child");
    if (configSync) {
      await env.data.tenants.update("child", { config_sync: configSync });
    }
    await env.data.emailProviders.create("child", {
      name: "mailgun",
      enabled: true,
      credentials: { api_key: "k" },
      scope: "platform",
    } as never);
    return withPlatformRowsHidden(env.data, {
      tenantId: "child",
      isOperator: false,
    });
  }

  it.each(["synced", "detached"] as const)(
    "is hidden for a %s tenant",
    async (mode) => {
      const data = await setup(mode);
      expect(await data.emailProviders.get("child")).toBeNull();
    },
  );

  it("is the tenant's own when it never received config", async () => {
    const data = await setup();
    expect(await data.emailProviders.get("child")).toMatchObject({
      name: "mailgun",
    });
  });
});
