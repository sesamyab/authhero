import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import { withRuntimeFallback } from "../src/middleware/settings-inheritance";
import { compareShadow } from "../src/inheritance/shadow";
import { createShadowReporter } from "../src/inheritance/report";
import { createMigratedDb } from "./helpers/migrated-db";

const cp = "control_plane";
const child = "tenant-1";

describe("config inheritance shadow mode", () => {
  let db: Kysely<Database>;
  let base: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    db = await createMigratedDb();
    base = createAdapters(db);
    await base.tenants.create({ id: cp, friendly_name: "Control Plane" });
    await base.tenants.create({ id: child, friendly_name: "Child" });
  });

  async function seedMatching() {
    await base.connections.create(cp, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp", client_secret: "cp-secret" },
    });
    await base.connections.create(child, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "own" },
    });
    await base.hooks.create(cp, {
      trigger_id: "post-user-login",
      url: "https://example.com/hook",
      enabled: true,
      metadata: { inheritable: true },
    });
    await base.emailProviders.create(cp, {
      name: "mailgun",
      enabled: true,
      credentials: { api_key: "k" },
    });
  }

  it("reports no unexpected differences when both models agree", async () => {
    await seedMatching();
    const diffs = await compareShadow({
      adapters: base,
      tenantId: child,
      legacyControlPlane: cp,
    });
    expect(diffs.filter((d) => !d.expected)).toEqual([]);
  });

  it("reports a difference when explicit publishing fields diverge", async () => {
    await seedMatching();
    // Legacy lets the tenant override; override=none makes the new model not.
    const [cpConn] = (await base.connections.list(cp)).connections;
    await base.connections.update(cp, cpConn!.id, { override: "none" });

    const diffs = await compareShadow({
      adapters: base,
      tenantId: child,
      legacyControlPlane: cp,
    });
    const changed = diffs.find(
      (d) => d.entity === "connection" && d.kind === "changed",
    );
    expect(changed).toBeDefined();
    expect(changed!.fields).toContain("options");
    expect(JSON.stringify(diffs)).not.toContain("cp-secret");
  });

  it("flags rows only the new model materialises as expected", async () => {
    await seedMatching();
    await base.resourceServers.create(cp, {
      identifier: "https://api.example.com",
      name: "api",
      is_system: true,
    });
    const diffs = await compareShadow({
      adapters: base,
      tenantId: child,
      legacyControlPlane: cp,
    });
    expect(diffs).toContainEqual(
      expect.objectContaining({
        entity: "resourceServer",
        kind: "extra",
        expected: true,
      }),
    );
  });

  it("writes cfgdiff logs from the runtime adapter, deduped, without changing reads", async () => {
    await seedMatching();
    const [cpConn] = (await base.connections.list(cp)).connections;
    await base.connections.update(cp, cpConn!.id, { override: "none" });

    const adapters = withRuntimeFallback(base, {
      controlPlaneTenantId: cp,
      inheritanceShadow: { intervalMs: 0 },
    }) as typeof base;
    const plain = withRuntimeFallback(base, {
      controlPlaneTenantId: cp,
    }) as typeof base;

    const withShadow = await adapters.connections.list(child);
    const without = await plain.connections.list(child);
    expect(withShadow).toEqual(without);

    await new Promise((r) => setTimeout(r, 300));
    await adapters.connections.list(child);
    await new Promise((r) => setTimeout(r, 300));

    const { logs } = await base.logs.list(child, { q: "type:cfgdiff" });
    const connectionLogs = logs.filter((l) =>
      l.description?.includes("changed connection"),
    );
    expect(connectionLogs).toHaveLength(1);
    expect(JSON.stringify(connectionLogs[0]!.details)).not.toContain(
      "cp-secret",
    );
  });

  it("never throws into the request when the comparison fails", async () => {
    const broken = {
      ...base,
      tenants: {
        ...base.tenants,
        get: async () => {
          throw new Error("boom");
        },
      },
    } as typeof base;
    const reporter = createShadowReporter(broken, {});
    expect(() => reporter.schedule(child, cp)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});
