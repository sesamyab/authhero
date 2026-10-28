import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import { isSyncedRowId } from "authhero";
import {
  createInProcessDetach,
  createInProcessSyncConfig,
  createInlineExecutor,
  createOperationRecorder,
  enqueueTenantOperation,
  runDetachStep,
} from "../src/operations";
import {
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
} from "../src/rollout/resolved-sync";
import { createConfigSyncResolver } from "../src/middleware/config-sync-mode";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const CHILD = "child";
const CODE = "exports.onExecutePostLogin = async () => {};";

describe("detach operation", () => {
  let db: Kysely<Database>;
  let raw: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    db = await createMigratedDb();
    raw = createAdapters(db);
    for (const id of [CP, CHILD]) {
      await raw.tenants.create({ id, friendly_name: id });
    }
    await raw.tenants.update(CHILD, { config_sync: "synced" });
  });

  /** A synced child with a copy of every kind of shared row. */
  async function syncedChild() {
    await raw.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp" },
      scope: "shared",
      override: "none",
      enforce: true,
    } as never);
    await raw.resourceServers.create(CP, {
      identifier: "https://api.example.com",
      name: "api",
      scope: "shared",
      override: "none",
    } as never);
    const code = await raw.hookCode.create(CP, { code: CODE });
    await raw.actions.create(CP, {
      name: "enrich",
      code: CODE,
      scope: "shared",
    });
    await raw.hooks.create(CP, {
      trigger_id: "post-user-login",
      code_id: code.id,
      enabled: true,
      scope: "shared",
    } as never);
    await raw.actions.create(CP, {
      name: "platform-action",
      code: CODE,
      scope: "platform",
    });

    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(block, raw, CHILD);

    // The tenant's own rows, and a client that uses the copied connection.
    const own = await raw.connections.create(CHILD, {
      name: "own",
      strategy: "github",
      options: { client_id: "own" },
    });
    const copy = (await raw.connections.list(CHILD)).connections.find(
      (c) => c.name === "google",
    )!;
    await raw.clients.create(CHILD, {
      client_id: "app",
      client_secret: "s",
      name: "app",
    });
    await raw.clientConnections.updateByClient(CHILD, "app", [
      own.id!,
      copy.id!,
    ]);
    return { own, copy };
  }

  const syRows = async () => {
    const connections = (await raw.connections.list(CHILD)).connections;
    const resourceServers = (await raw.resourceServers.list(CHILD))
      .resource_servers;
    const actions = (await raw.actions.list(CHILD)).actions;
    const hooks = (await raw.hooks.list(CHILD)).hooks;
    return {
      connections: connections.filter((c) => isSyncedRowId(c.id)),
      resourceServers: resourceServers.filter((r) => isSyncedRowId(r.id)),
      actions: actions.filter((a) => isSyncedRowId(a.id)),
      hooks: hooks.filter((h) => isSyncedRowId(h.hook_id)),
    };
  };

  it("turns the copies into the tenant's own rows and leaves the tenant detached", async () => {
    const { copy } = await syncedChild();
    const detach = createInProcessDetach(raw);

    const result = await detach(CHILD, { dryRun: false, clean: false });

    expect(result.status).toBe("detached");
    expect(result.entities.connection.converted).toBe(1);
    expect(result.entities.hook.converted).toBe(1);

    // Content is kept under normal ids, with nothing that locks it.
    const connections = (await raw.connections.list(CHILD)).connections;
    const google = connections.find((c) => c.name === "google")!;
    expect(isSyncedRowId(google.id)).toBe(false);
    expect(google.options).toMatchObject({ client_id: "cp" });
    expect(google.scope).toBeFalsy();
    expect(google.override).toBeFalsy();
    expect(google.enforce).toBeFalsy();
    expect(await raw.connections.get(CHILD, copy.id!)).toBeNull();

    // The client now uses the new row, and the hook runs the new code.
    expect(
      (await raw.clientConnections.listByClient(CHILD, "app")).map((c) => c.id),
    ).toContain(google.id);
    const [hook] = (await raw.hooks.list(CHILD)).hooks;
    const codeId = (hook as { code_id?: string }).code_id!;
    expect(isSyncedRowId(codeId)).toBe(false);
    expect(await raw.hookCode.get(CHILD, codeId)).toBeTruthy();

    // The platform action stays a copy, and is reported.
    const synced = await syRows();
    expect(synced.actions.map((a) => a.name)).toEqual(["platform-action"]);
    expect(result.changes).toContain(
      "skip action:platform-action (platform: stays a copy)",
    );
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { entity: "action", key: "platform-action", action: "kept" },
        {
          entity: "connection",
          key: "google-oauth2:google",
          action: "converted",
        },
      ]),
    );

    // Nothing locks or syncs the tenant any more.
    const tenant = (await raw.tenants.get(CHILD))!;
    expect(tenant.config_sync).toBe("detached");
    expect(tenant.parent_tenant_id).toBeFalsy();
    expect(tenant.config_sync_hash).toBeFalsy();
  });

  it("writes nothing on a dry run", async () => {
    await syncedChild();

    const result = await createInProcessDetach(raw)(CHILD, {
      dryRun: true,
      clean: false,
    });

    expect(result.status).toBe("dry-run");
    expect(result.changes).toEqual(
      expect.arrayContaining(["convert connection:google-oauth2:google"]),
    );
    expect((await syRows()).connections).toHaveLength(1);
    expect((await raw.tenants.get(CHILD))!.config_sync).toBe("synced");
  });

  it("removes every copy with clean, platform rows too, and keeps the tenant's own", async () => {
    const { own } = await syncedChild();

    const result = await createInProcessDetach(raw)(CHILD, {
      dryRun: false,
      clean: true,
    });

    expect(result.status).toBe("detached");
    const synced = await syRows();
    expect(synced.connections).toHaveLength(0);
    expect(synced.resourceServers).toHaveLength(0);
    expect(synced.actions).toHaveLength(0);
    expect(synced.hooks).toHaveLength(0);
    expect(
      (await raw.connections.list(CHILD)).connections.map((c) => c.id),
    ).toEqual([own.id]);
    expect(
      (await raw.clientConnections.listByClient(CHILD, "app")).map((c) => c.id),
    ).toEqual([own.id]);
  });

  it("is a no-op for a tenant that is already detached", async () => {
    await syncedChild();
    const detach = createInProcessDetach(raw);
    await detach(CHILD, { dryRun: false, clean: false });

    const again = await detach(CHILD, { dryRun: false, clean: false });

    expect(again.status).toBe("already-detached");
    expect(again.changes).toEqual([]);
  });

  it("refuses a tenant with its own database", async () => {
    await raw.tenants.update(CHILD, { deployment_type: "wfp" } as never);

    await expect(
      createInProcessDetach(raw)(CHILD, { dryRun: false, clean: false }),
    ).rejects.toThrow(/own database/);
  });

  it("stops the tenant from being synced again, and from inheriting", async () => {
    await syncedChild();
    await createInProcessDetach(raw)(CHILD, { dryRun: false, clean: false });

    await expect(
      createInProcessSyncConfig(raw, { controlPlaneTenantId: CP })(CHILD, {
        dryRun: false,
        force: false,
      }),
    ).rejects.toThrow(/detached/);

    const resolver = createConfigSyncResolver({
      base: ({ tenant_id }) => ({ tenantId: tenant_id }),
      getTenant: (id) => raw.tenants.get(id),
      controlPlaneTenantId: CP,
    });
    expect(await resolver.isSynced(CHILD)).toBe(true);
  });

  it("runs as an operation with history and a result", async () => {
    await syncedChild();
    const stores = {
      tenantOperations: raw.tenantOperations,
      tenantOperationEvents: raw.tenantOperationEvents,
    };
    const recorder = createOperationRecorder(stores);
    const detachTenant = createInProcessDetach(raw);
    const executor = createInlineExecutor({
      stores,
      definitions: {
        detach: (operation) => [
          {
            name: "detach",
            run: () => runDetachStep({ operation, detachTenant, recorder }),
          },
        ],
      },
    });

    const operation = await enqueueTenantOperation(
      stores,
      executor,
      { kind: "detach", tenant_id: CHILD, input: { dry_run: true } },
      { returnFailed: true },
    );

    expect(operation.status).toBe("succeeded");
    expect(operation.result).toMatchObject({
      dry_run: true,
      clean: false,
      status: "dry-run",
    });
  });
});
