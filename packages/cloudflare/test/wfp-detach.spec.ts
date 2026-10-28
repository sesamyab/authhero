import { describe, it, expect, beforeEach } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { isSyncedRowId } from "authhero";
import {
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
} from "@authhero/multi-tenancy";
import { createDispatchDetach, createWfpTenantApp } from "../src/wfp";

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

describe("detach operation transport (createDispatchDetach → /internal/detach)", () => {
  const env = {
    AUTH_DB: {},
    ENCRYPTION_KEY: b64Key(1),
    ISSUER: "https://acme.tokens.example.com/",
    CONTROL_PLANE_TENANT_ID: CP,
    CONTROL_PLANE_ISSUER: "https://controlplane.example.com/",
    WFP_INTERNAL_SYNC_SECRET: "push-secret",
    TENANT_ID: "acme",
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  let cp: DataAdapters;
  let tenant: DataAdapters;
  let app: ReturnType<typeof createWfpTenantApp>;
  let calls: string[];

  const dispatcherToTenant = (tenantEnv: Record<string, unknown> = env) => ({
    get() {
      return {
        async fetch(url: Request | string, init?: RequestInit) {
          calls.push(typeof url === "string" ? url : url.url);
          return app.fetch(new Request(url, init), tenantEnv, ctx);
        },
      };
    },
  });

  const detachFor = (
    dispatcher: ReturnType<typeof dispatcherToTenant>,
    secret = "push-secret",
  ) =>
    createDispatchDetach({
      dispatcher,
      internalSecret: secret,
      controlPlaneAdapters: cp,
    });

  beforeEach(async () => {
    calls = [];
    cp = await makeAdapters();
    tenant = await makeAdapters();
    app = createWfpTenantApp({ createDataAdapter: () => tenant });

    await cp.tenants.create({ ...tenantRow(CP) });
    await cp.tenants.create({ ...tenantRow("acme"), config_sync: "synced" });
    await tenant.tenants.create(tenantRow("acme"));
    await cp.actions.create(CP, {
      name: "enrich",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "shared",
    });
    await cp.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp" },
      scope: "shared",
    } as never);

    // The tenant's own database holds the copies a sync delivered.
    const block = await buildResolvedConfigBlock(cp, "acme", {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(block, tenant, "acme");
  });

  const copies = async () => ({
    actions: (await tenant.actions.list("acme")).actions,
    connections: (await tenant.connections.list("acme")).connections,
  });

  it("converts the copies in the tenant's database and marks both tenant rows", async () => {
    const result = await detachFor(dispatcherToTenant())("acme", {
      dryRun: false,
      clean: false,
    });

    expect(calls).toEqual(["https://tenant.internal/internal/detach"]);
    expect(result.status).toBe("detached");
    const { actions, connections } = await copies();
    expect(actions.map((a) => a.name)).toEqual(["enrich"]);
    expect(isSyncedRowId(actions[0]!.id)).toBe(false);
    expect(isSyncedRowId(connections[0]!.id)).toBe(false);

    for (const db of [cp, tenant]) {
      const row = (await db.tenants.get("acme"))!;
      expect(row.config_sync).toBe("detached");
      expect(row.config_sync_hash).toBeFalsy();
    }
  });

  it("removes the copies with clean", async () => {
    await detachFor(dispatcherToTenant())("acme", {
      dryRun: false,
      clean: true,
    });

    const { actions, connections } = await copies();
    expect(actions).toHaveLength(0);
    expect(connections).toHaveLength(0);
    expect((await cp.tenants.get("acme"))!.config_sync).toBe("detached");
  });

  it("writes nothing on a dry run, on either side", async () => {
    const result = await detachFor(dispatcherToTenant())("acme", {
      dryRun: true,
      clean: false,
    });

    expect(result.status).toBe("dry-run");
    expect(result.changes).toContain("convert action:enrich");
    expect(isSyncedRowId((await copies()).actions[0]!.id)).toBe(true);
    expect((await cp.tenants.get("acme"))!.config_sync).toBe("synced");
  });

  it("refuses a tenant that is not synced before it pushes anything", async () => {
    await cp.tenants.update("acme", { config_sync: "inherit-on-read" });

    await expect(
      detachFor(dispatcherToTenant())("acme", { dryRun: false, clean: false }),
    ).rejects.toThrow(/not synced/);
    expect(calls).toEqual([]);
  });

  it("answers already-detached without pushing", async () => {
    await cp.tenants.update("acme", { config_sync: "detached" });

    const result = await detachFor(dispatcherToTenant())("acme", {
      dryRun: false,
      clean: false,
    });

    expect(result.status).toBe("already-detached");
    expect(calls).toEqual([]);
  });

  it("leaves the control-plane row alone when the worker reports a partial result", async () => {
    const dispatcher = {
      get() {
        return {
          async fetch() {
            return Response.json({
              status: "partial",
              changes: [],
              rows: [],
              entities: {},
            });
          },
        };
      },
    };

    const result = await detachFor(dispatcher as never)("acme", {
      dryRun: false,
      clean: false,
    });

    expect(result.status).toBe("partial");
    expect((await cp.tenants.get("acme"))!.config_sync).toBe("synced");
  });

  it("is refused with the wrong secret", async () => {
    await expect(
      detachFor(dispatcherToTenant(), "wrong")("acme", {
        dryRun: false,
        clean: false,
      }),
    ).rejects.toThrow(/401/);
  });

  it("is refused when it reaches another tenant's worker", async () => {
    await expect(
      detachFor(dispatcherToTenant({ ...env, TENANT_ID: "other" }))("acme", {
        dryRun: false,
        clean: false,
      }),
    ).rejects.toThrow(/403.*detach_tenant_mismatch/);
    expect(isSyncedRowId((await copies()).actions[0]!.id)).toBe(true);
  });
});
