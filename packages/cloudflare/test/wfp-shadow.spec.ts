import { describe, it, expect, beforeEach } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { createWfpTenantApp } from "../src/wfp";

const CP = "control_plane";

function b64Key(seed: number): string {
  return Buffer.from(new Uint8Array(32).fill(seed)).toString("base64");
}

async function makeAdapters(): Promise<DataAdapters> {
  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrateToLatest(db, false);
  return createAdapters(db) as DataAdapters;
}

const tenantRow = (id: string) => ({
  id,
  friendly_name: id,
  audience: "https://example.com",
  default_audience: "https://example.com",
  sender_email: "login@example.com",
  sender_name: "Sender",
});

describe("config inheritance shadow mode in the tenant worker", () => {
  const env = {
    AUTH_DB: {},
    ENCRYPTION_KEY: b64Key(1),
    ISSUER: "https://acme.tokens.example.com/",
    CONTROL_PLANE_TENANT_ID: CP,
    CONTROL_PLANE_ISSUER: "https://controlplane.example.com/",
    WFP_INTERNAL_SYNC_SECRET: "push-secret",
    TENANT_ID: "acme",
  };

  let tenant: DataAdapters;
  let waited: Promise<unknown>[];
  const ctx = () =>
    ({
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException() {},
    }) as never;

  const request =
    (path: string, tenantEnv: Record<string, unknown> = env) =>
    (options: Parameters<typeof createWfpTenantApp>[0]) =>
      createWfpTenantApp({ ...options, createDataAdapter: () => tenant }).fetch(
        new Request(`https://acme.tokens.example.com${path}`),
        tenantEnv as never,
        ctx(),
      );

  const cfgdiffs = async () =>
    (await tenant.logs.list("acme", { q: "type:cfgdiff" })).logs;

  beforeEach(async () => {
    waited = [];
    tenant = await makeAdapters();
    // What provisioning leaves in the tenant's own database: the projected
    // control-plane rows, and the tenant's own.
    await tenant.tenants.create(tenantRow(CP));
    await tenant.tenants.create(tenantRow("acme"));
    await tenant.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp", client_secret: "cp-secret" },
      override: "none",
    } as never);
    await tenant.connections.create("acme", {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "own" },
    });
  });

  it("logs a difference between the fallback and the chain, kept alive with waitUntil", async () => {
    const response = await request("/.well-known/openid-configuration")({
      createDataAdapter: () => tenant,
      inheritanceShadow: true,
    });

    expect(response.status).toBe(200);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);

    const logs = await cfgdiffs();
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).toContain("connection");
    expect(JSON.stringify(logs)).not.toContain("cp-secret");
  });

  it("does nothing without the option", async () => {
    await request("/.well-known/openid-configuration")({
      createDataAdapter: () => tenant,
    });

    expect(waited).toHaveLength(0);
    expect(await cfgdiffs()).toHaveLength(0);
  });

  it("does not compare on the control plane's own internal calls", async () => {
    await request("/internal/unknown")({
      createDataAdapter: () => tenant,
      inheritanceShadow: true,
    });

    expect(waited).toHaveLength(0);
  });

  it("is rate-limited per tenant", async () => {
    const app = createWfpTenantApp({
      createDataAdapter: () => tenant,
      inheritanceShadow: true,
    });
    const go = () =>
      app.fetch(
        new Request(
          "https://acme.tokens.example.com/.well-known/openid-configuration",
        ),
        env as never,
        ctx(),
      );

    await go();
    await Promise.all(waited);
    const afterFirst = (await cfgdiffs()).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Dropping what was logged makes a second comparison visible.
    await go();
    await go();
    await Promise.all(waited);
    expect((await cfgdiffs()).length).toBe(afterFirst);
  });

  describe("a tenant whose row names a parent", () => {
    const compare = async () => {
      await request("/.well-known/openid-configuration")({
        createDataAdapter: () => tenant,
        inheritanceShadow: true,
      });
      await Promise.all(waited);
      return (await cfgdiffs()).length;
    };

    it("is not compared while this database lacks that parent", async () => {
      await tenant.tenants.update("acme", { parent_tenant_id: "partner" });

      expect(await compare()).toBe(0);
    });

    it("is compared once the whole chain is here", async () => {
      await tenant.tenants.create(tenantRow("partner"));
      await tenant.tenants.update("acme", { parent_tenant_id: "partner" });

      expect(await compare()).toBeGreaterThan(0);
    });
  });
});
