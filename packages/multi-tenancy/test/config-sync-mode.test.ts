import { beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import { createConfigSyncResolver } from "../src/middleware/config-sync-mode";
import {
  buildResolver,
  withRuntimeFallback,
} from "../src/middleware/settings-inheritance";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const CHILD = "tenant-1";

describe("createConfigSyncResolver", () => {
  const base = async () => ({ tenantId: CP, clientId: "cp-client" });

  it("inherits for unset and inherit-on-read tenants and not for synced ones", async () => {
    const modes: Record<string, string | null | undefined> = {
      unset: undefined,
      explicit: "inherit-on-read",
      synced: "synced",
    };
    const resolver = createConfigSyncResolver({
      base,
      getTenant: async (id) => ({ config_sync: modes[id] }),
      controlPlaneTenantId: CP,
    });

    expect(await resolver.resolve({ tenant_id: "unset" })).toEqual({
      tenantId: CP,
      clientId: "cp-client",
    });
    expect(await resolver.resolve({ tenant_id: "explicit" })).toBeDefined();
    expect(await resolver.resolve({ tenant_id: "synced" })).toBeUndefined();
  });

  it("respects a base that already opts a tenant out, without looking it up", async () => {
    const getTenant = vi.fn(async () => ({ config_sync: "synced" }));
    const resolver = createConfigSyncResolver({
      base: async () => undefined,
      getTenant,
    });

    expect(await resolver.resolve({ tenant_id: "x" })).toBeUndefined();
    expect(getTenant).not.toHaveBeenCalled();
  });

  it("never treats the control plane as synced", async () => {
    const getTenant = vi.fn(async () => ({ config_sync: "synced" }));
    const resolver = createConfigSyncResolver({
      base: async () => ({ tenantId: CP }),
      getTenant,
      controlPlaneTenantId: CP,
    });

    expect(await resolver.isSynced(CP)).toBe(false);
    expect(await resolver.resolve({ tenant_id: CP })).toEqual({ tenantId: CP });
    expect(getTenant).not.toHaveBeenCalled();
  });

  it("remembers the mode for the ttl and forgets it on invalidate", async () => {
    let mode: string = "inherit-on-read";
    const getTenant = vi.fn(async () => ({ config_sync: mode }));
    const resolver = createConfigSyncResolver({
      base,
      getTenant,
      ttlMs: 60_000,
    });

    expect(await resolver.isSynced(CHILD)).toBe(false);
    mode = "synced";
    expect(await resolver.isSynced(CHILD)).toBe(false);
    expect(getTenant).toHaveBeenCalledTimes(1);

    resolver.invalidate(CHILD);
    expect(await resolver.isSynced(CHILD)).toBe(true);
    expect(getTenant).toHaveBeenCalledTimes(2);
  });

  it("re-reads after the ttl expires", async () => {
    vi.useFakeTimers();
    try {
      let mode: string = "inherit-on-read";
      const resolver = createConfigSyncResolver({
        base,
        getTenant: async () => ({ config_sync: mode }),
        ttlMs: 1000,
      });
      expect(await resolver.isSynced(CHILD)).toBe(false);
      mode = "synced";
      vi.advanceTimersByTime(1001);
      expect(await resolver.isSynced(CHILD)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notices a flip within 10 seconds when no ttl is given", async () => {
    vi.useFakeTimers();
    try {
      let mode: string = "inherit-on-read";
      const resolver = createConfigSyncResolver({
        base,
        getTenant: async () => ({ config_sync: mode }),
      });
      expect(await resolver.isSynced(CHILD)).toBe(false);
      mode = "synced";

      vi.advanceTimersByTime(9_000);
      expect(await resolver.isSynced(CHILD)).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(await resolver.isSynced(CHILD)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps inheriting when the lookup fails, and does not cache the failure", async () => {
    let fail = true;
    const getTenant = vi.fn(async () => {
      if (fail) throw new Error("db down");
      return { config_sync: "synced" };
    });
    const resolver = createConfigSyncResolver({ base, getTenant });

    expect(await resolver.resolve({ tenant_id: CHILD })).toBeDefined();
    fail = false;
    expect(await resolver.resolve({ tenant_id: CHILD })).toBeUndefined();
  });
});

describe("config_sync modes through the runtime fallback adapter", () => {
  let db: Kysely<Database>;
  let base: ReturnType<typeof createAdapters>;
  let adapters: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    db = await createMigratedDb();
    base = createAdapters(db);
    await base.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await base.tenants.create({ id: CHILD, friendly_name: "Child" });

    await base.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp", client_secret: "cp-secret" },
    });
    await base.connections.create(CHILD, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "own" },
    });
    await base.hooks.create(CP, {
      trigger_id: "post-user-login",
      url: "https://example.com/hook",
      enabled: true,
      metadata: { inheritable: true },
    });
    await base.emailProviders.create(CP, {
      name: "mailgun",
      enabled: true,
      credentials: { api_key: "k" },
    });
    await base.resourceServers.create(CP, {
      identifier: "https://api.example.com",
      name: "api",
      is_system: true,
      scopes: [{ value: "read:cp", description: "from cp" }],
    });

    adapters = withRuntimeFallback(base, {
      controlPlaneTenantId: CP,
      configSync: createConfigSyncResolver({
        base: buildResolver({ controlPlaneTenantId: CP }),
        getTenant: async (id) => (await base.tenants.get(id)) ?? null,
        controlPlaneTenantId: CP,
        ttlMs: 0,
      }),
    }) as typeof base;
  });

  async function readAll() {
    const connections = (await adapters.connections.list(CHILD)).connections;
    const hooks = (
      await adapters.hooks.list(CHILD, {
        q: "trigger_id:post-user-login",
        page: 0,
        per_page: 100,
        include_totals: false,
      })
    ).hooks;
    return {
      secret: connections[0]?.options?.client_secret,
      hooks: hooks.length,
      email: await adapters.emailProviders.get(CHILD),
    };
  }

  it("inherits at read time by default", async () => {
    const read = await readAll();
    expect(read.secret).toBe("cp-secret");
    expect(read.hooks).toBe(1);
    expect(read.email).toMatchObject({ name: "mailgun" });
  });

  it("reads only the local database once the tenant is synced, and back again", async () => {
    await base.tenants.update(CHILD, { config_sync: "synced" });

    const synced = await readAll();
    expect(synced.secret).toBeUndefined();
    expect(synced.hooks).toBe(0);
    expect(synced.email).toBeNull();
    expect(
      (await adapters.connections.list(CHILD)).connections[0]?.options,
    ).toMatchObject({ client_id: "own" });

    // Rollback: flipping the mode restores read-time inheritance.
    await base.tenants.update(CHILD, { config_sync: "inherit-on-read" });
    const back = await readAll();
    expect(back.secret).toBe("cp-secret");
    expect(back.hooks).toBe(1);
  });

  it("leaves the control plane's own data untouched by either mode", async () => {
    await base.tenants.update(CHILD, { config_sync: "synced" });
    await readAll();
    await base.tenants.update(CHILD, { config_sync: "inherit-on-read" });
    await readAll();

    const cpConnection = (await base.connections.list(CP)).connections[0]!;
    expect(cpConnection.options).toMatchObject({
      client_id: "cp",
      client_secret: "cp-secret",
    });
    expect((await base.hooks.list(CP)).hooks).toHaveLength(1);
    expect(await base.emailProviders.get(CP)).toMatchObject({
      name: "mailgun",
    });
  });

  it("applies the mode to system resource server scope inheritance", async () => {
    await base.resourceServers.create(CHILD, {
      identifier: "https://api.example.com",
      name: "api",
      is_system: true,
      scopes: [{ value: "read:own", description: "own" }],
    });
    const [own] = (await base.resourceServers.list(CHILD)).resource_servers;
    const cp = (await base.resourceServers.list(CP)).resource_servers[0]!;
    // Sync preserves ids, which is how the wrapper finds the counterpart.
    await db
      .updateTable("resource_servers")
      .set({ id: cp.id })
      .where("tenant_id", "=", CHILD)
      .where("id", "=", own!.id!)
      .execute();

    const scopes = async () =>
      (await adapters.resourceServers.get(CHILD, cp.id!))?.scopes?.map(
        (s) => s.value,
      );

    expect(await scopes()).toEqual(expect.arrayContaining(["read:cp"]));
    await base.tenants.update(CHILD, { config_sync: "synced" });
    expect(await scopes()).toEqual(["read:own"]);
  });

  it("exposes a mode-aware resolver for helpers that read multiTenancyConfig", async () => {
    const resolve = adapters.multiTenancyConfig?.resolveControlPlane;
    expect(await resolve?.({ tenant_id: CHILD })).toMatchObject({
      tenantId: CP,
    });
    await base.tenants.update(CHILD, { config_sync: "synced" });
    expect(await resolve?.({ tenant_id: CHILD })).toBeUndefined();
  });

  it("does not run the shadow comparison for synced tenants", async () => {
    // With a parent the resolver would find inherited rows that read-time
    // inheritance (disabled by synced mode) does not return: pure noise.
    await base.tenants.update(CHILD, { parent_tenant_id: CP });
    const make = () =>
      withRuntimeFallback(base, {
        controlPlaneTenantId: CP,
        inheritanceShadow: { intervalMs: 0, includeExpected: true },
        configSync: createConfigSyncResolver({
          base: buildResolver({ controlPlaneTenantId: CP }),
          getTenant: async (id) => (await base.tenants.get(id)) ?? null,
          controlPlaneTenantId: CP,
          ttlMs: 0,
        }),
      }) as typeof base;
    const countLogs = async () =>
      (await base.logs.list(CHILD, { q: "type:cfgdiff" })).logs.length;

    // Control: an inheriting tenant is compared and the noise shows up.
    await make().connections.list(CHILD);
    await new Promise((r) => setTimeout(r, 300));
    const before = await countLogs();
    expect(before).toBeGreaterThan(0);

    await base.tenants.update(CHILD, { config_sync: "synced" });
    await make().connections.list(CHILD);
    await new Promise((r) => setTimeout(r, 300));
    expect(await countLogs()).toBe(before);
  });
});
