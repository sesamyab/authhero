import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import {
  createInProcessSyncConfig,
  createInlineExecutor,
  createOperationRecorder,
  enqueueTenantOperation,
  runSyncDefaultsStep,
} from "../src/operations";
import type { SyncConfigFn } from "../src/operations";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const CHILD = "tenant-1";

describe("sync-defaults operation (inline)", () => {
  let db: Kysely<Database>;
  let adapters: ReturnType<typeof createAdapters>;
  let stores: {
    tenantOperations: typeof adapters.tenantOperations;
    tenantOperationEvents: typeof adapters.tenantOperationEvents;
  };

  function executorFor(syncConfig: SyncConfigFn) {
    const recorder = createOperationRecorder(stores);
    return createInlineExecutor({
      stores,
      definitions: {
        "sync-defaults": (operation) => [
          {
            name: "sync-defaults",
            run: () => runSyncDefaultsStep({ operation, syncConfig, recorder }),
          },
        ],
      },
    });
  }

  const inProcess = () =>
    createInProcessSyncConfig(adapters, { controlPlaneTenantId: CP });

  const enqueue = (
    syncConfig: SyncConfigFn,
    input?: Record<string, unknown>,
    tenantId: string | null = CHILD,
  ) =>
    enqueueTenantOperation(
      stores,
      executorFor(syncConfig),
      { kind: "sync-defaults", tenant_id: tenantId, input },
      { returnFailed: true },
    );

  beforeEach(async () => {
    db = await createMigratedDb();
    adapters = createAdapters(db);
    stores = {
      tenantOperations: adapters.tenantOperations,
      tenantOperationEvents: adapters.tenantOperationEvents,
    };
    await adapters.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await adapters.tenants.create({ id: CHILD, friendly_name: "Child" });
    await adapters.actions.create(CP, {
      name: "enrich",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "shared",
    });
  });

  it("syncs a tenant as an operation with history and a result", async () => {
    const operation = await enqueue(inProcess());

    expect(operation.status).toBe("succeeded");
    expect(operation.kind).toBe("sync-defaults");
    expect(operation.engine).toBe("inline");
    expect(operation.result).toMatchObject({
      dry_run: false,
      status: "applied",
      entities: { action: { added: 1, errors: 0 } },
    });
    expect(operation.result?.changes).toContain("action:enrich");

    const { events } = await adapters.tenantOperationEvents.listByOperation(
      operation.id,
    );
    expect(events.map((e) => `${e.step}:${e.outcome}`)).toEqual([
      "sync-defaults:started",
      "sync-defaults:succeeded",
    ]);

    expect((await adapters.actions.list(CHILD)).actions).toHaveLength(1);
    expect((await adapters.tenants.get(CHILD))?.config_sync_hash).toBe(
      operation.result?.hash,
    );
  });

  it("returns the diff for a dry run and writes nothing", async () => {
    const operation = await enqueue(inProcess(), { dry_run: true });

    expect(operation.status).toBe("succeeded");
    expect(operation.input).toEqual({ dry_run: true });
    expect(operation.result).toMatchObject({
      dry_run: true,
      status: "dry-run",
      entities: { action: { added: 1 } },
    });
    expect((await adapters.actions.list(CHILD)).actions).toHaveLength(0);
    expect(
      (await adapters.tenants.get(CHILD))?.config_sync_hash,
    ).toBeUndefined();
  });

  it("is up to date on a second run, and force applies anyway", async () => {
    await enqueue(inProcess());

    const again = await enqueue(inProcess());
    expect(again.result).toMatchObject({ status: "up-to-date" });

    const forced = await enqueue(inProcess(), { force: true });
    expect(forced.result).toMatchObject({
      status: "applied",
      entities: { action: { unchanged: 1 } },
    });
  });

  it("leaves a failed, queryable row when rows report errors", async () => {
    const failing: SyncConfigFn = async () => ({
      status: "applied",
      hash: "abc",
      changes: [],
      entities: {
        connection: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
        resourceServer: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
        hookCode: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
        action: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: ["action enrich: boom", "action other: bang"],
        },
        hook: { added: 0, changed: 0, unchanged: 0, deleted: 0, errors: [] },
        emailProvider: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
        branding: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
        promptSettings: {
          added: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          errors: [],
        },
      },
    });

    const operation = await enqueue(failing);

    expect(operation.status).toBe("failed");
    expect(operation.error).toMatch(/2 error\(s\): action enrich: boom/);
    expect(operation.result).toMatchObject({
      entities: { action: { errors: 2 } },
    });

    const queried = await adapters.tenantOperations.list({
      tenant_id: CHILD,
      kind: "sync-defaults",
      status: ["failed"],
    });
    expect(queried.operations.map((o) => o.id)).toEqual([operation.id]);
    const { events } = await adapters.tenantOperationEvents.listByOperation(
      operation.id,
    );
    expect(events.at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("keeps the structured rows and a capped list of error messages on the result", async () => {
    const entityOutcome = {
      added: 0,
      changed: 0,
      unchanged: 0,
      deleted: 0,
      errors: [] as string[],
    };
    const noisy: SyncConfigFn = async () => ({
      status: "applied",
      hash: "abc",
      changes: [
        "connection:google",
        "skip action:enrich (the tenant has its own)",
      ],
      rows: [
        { entity: "connection", key: "google", action: "added" },
        { entity: "action", key: "enrich", action: "skipped" },
      ],
      entities: {
        connection: { ...entityOutcome },
        resourceServer: { ...entityOutcome },
        hookCode: { ...entityOutcome },
        action: {
          ...entityOutcome,
          errors: Array.from(
            { length: 30 },
            (_, n) => `action a${n}: ${"x".repeat(400)}`,
          ),
        },
        hook: { ...entityOutcome },
        emailProvider: { ...entityOutcome },
        branding: { ...entityOutcome },
        promptSettings: { ...entityOutcome },
      },
    });

    const operation = await enqueue(noisy);

    const result = operation.result as {
      rows: unknown[];
      error_messages: string[];
    };
    expect(result.rows).toEqual([
      { entity: "connection", key: "google", action: "added" },
      { entity: "action", key: "enrich", action: "skipped" },
    ]);
    expect(result.error_messages).toHaveLength(20);
    expect(result.error_messages.every((m) => m.length <= 300)).toBe(true);
  });

  it("records a transport failure as a failed row", async () => {
    const operation = await enqueue(async () => {
      throw new Error("tenant worker unreachable");
    });

    expect(operation.status).toBe("failed");
    expect(operation.error).toBe("tenant worker unreachable");
  });

  it("refuses a tenant with its own database through the in-process sync", async () => {
    await adapters.tenants.update(CHILD, { deployment_type: "wfp" });

    const operation = await enqueue(inProcess());

    expect(operation.status).toBe("failed");
    expect(operation.error).toMatch(/own database/);
  });

  it("refuses an unknown tenant", async () => {
    const operation = await enqueue(inProcess(), undefined, "missing");

    expect(operation.status).toBe("failed");
    expect(operation.error).toMatch(/not found/);
  });

  it("requires a tenant", async () => {
    const operation = await enqueue(inProcess(), undefined, null);

    expect(operation.status).toBe("failed");
    expect(operation.error).toMatch(/require a tenant_id/);
  });

  it("rethrows a failed run unless the caller asks for the row", async () => {
    await expect(
      enqueueTenantOperation(
        stores,
        executorFor(async () => {
          throw new Error("nope");
        }),
        { kind: "sync-defaults", tenant_id: CHILD },
      ),
    ).rejects.toThrow("nope");
  });
});
