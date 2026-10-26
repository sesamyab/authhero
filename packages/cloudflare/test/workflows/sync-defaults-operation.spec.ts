import { describe, it, expect } from "vitest";
import type { ApplyResolvedBlockResult } from "@authhero/multi-tenancy";
import { runSyncDefaultsOperation } from "../../src/workflows";
import {
  fakeStepRunner,
  fakeStores,
  replayStepRunner,
  retryingStepRunner,
} from "./helpers";

const outcome = (over: Partial<{ errors: string[] }> = {}) => ({
  added: 0,
  changed: 0,
  unchanged: 0,
  deleted: 0,
  errors: [] as string[],
  ...over,
});

function applyResult(
  over: Partial<ApplyResolvedBlockResult> = {},
  actionErrors: string[] = [],
): ApplyResolvedBlockResult {
  return {
    status: "applied",
    hash: "hash-1",
    changes: ["action:enrich"],
    entities: {
      connection: outcome(),
      resourceServer: outcome(),
      hookCode: outcome(),
      action: { ...outcome({ errors: actionErrors }), added: 1 },
      hook: outcome(),
      emailProvider: outcome(),
      branding: outcome(),
      promptSettings: outcome(),
    },
    ...over,
  };
}

async function seed(
  stores: ReturnType<typeof fakeStores>,
  input?: Record<string, unknown>,
) {
  const op = await stores.tenantOperations.create({
    tenant_id: "kvartal",
    kind: "sync-defaults",
    engine: "cloudflare-workflows",
    input,
  });
  return {
    operation_id: op.id,
    tenant_id: "kvartal",
    kind: "sync-defaults" as const,
  };
}

describe("runSyncDefaultsOperation", () => {
  it("syncs the tenant, records the result and the step trail", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    const calls: Array<[string, unknown]> = [];
    const step = fakeStepRunner();

    await runSyncDefaultsOperation(
      {
        stores,
        syncConfig: async (tenantId, options) => {
          calls.push([tenantId, options]);
          return applyResult();
        },
      },
      params,
      step,
    );

    expect(calls).toEqual([["kvartal", { dryRun: false, force: false }]]);
    expect(step.calls.map((c) => c.name)).toEqual([
      "mark-running",
      "sync-defaults",
      "mark-succeeded",
    ]);
    const operation = stores.operations.get(params.operation_id)!;
    expect(operation.status).toBe("succeeded");
    expect(operation.finished_at).not.toBeNull();
    expect(operation.result).toMatchObject({
      status: "applied",
      hash: "hash-1",
      entities: { action: { added: 1, errors: 0 } },
    });
    expect(stores.events.map((e) => `${e.step}:${e.outcome}`)).toEqual([
      "sync-defaults:succeeded",
    ]);
  });

  it("passes dry_run and force from the operation input, and keeps the diff", async () => {
    const stores = fakeStores();
    const params = await seed(stores, { dry_run: true, force: true });
    const seen: unknown[] = [];

    await runSyncDefaultsOperation(
      {
        stores,
        syncConfig: async (_tenantId, options) => {
          seen.push(options);
          return applyResult({ status: "dry-run" });
        },
      },
      params,
      fakeStepRunner(),
    );

    expect(seen).toEqual([{ dryRun: true, force: true }]);
    expect(stores.operations.get(params.operation_id)?.result).toMatchObject({
      dry_run: true,
      status: "dry-run",
      changes: ["action:enrich"],
    });
  });

  it("uses a smaller retry budget than provisioning and lets hosts override it", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    const step = fakeStepRunner();

    await runSyncDefaultsOperation(
      {
        stores,
        syncConfig: async () => applyResult(),
        stepConfig: { "sync-defaults": { retries: { limit: 1, delay: 1 } } },
      },
      params,
      step,
    );

    expect(step.calls.find((c) => c.name === "mark-running")?.config).toEqual({
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "2 minutes",
    });
    expect(
      step.calls.find((c) => c.name === "sync-defaults")?.config?.retries,
    ).toEqual({ limit: 1, delay: 1 });
  });

  it("retries a transient transport failure and then succeeds", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    let attempts = 0;

    await runSyncDefaultsOperation(
      {
        stores,
        syncConfig: async () => {
          if (++attempts < 3) throw new Error("tenant worker unavailable");
          return applyResult();
        },
      },
      params,
      retryingStepRunner(),
    );

    expect(attempts).toBe(3);
    expect(stores.operations.get(params.operation_id)?.status).toBe(
      "succeeded",
    );
  });

  it("fails the operation when rows report errors, and still records the result", async () => {
    const stores = fakeStores();
    const params = await seed(stores);

    await expect(
      runSyncDefaultsOperation(
        {
          stores,
          syncConfig: async () => applyResult({}, ["action enrich: boom"]),
        },
        params,
        retryingStepRunner(),
      ),
    ).rejects.toThrow(
      /sync-defaults reported 1 error\(s\): action enrich: boom/,
    );

    const operation = stores.operations.get(params.operation_id)!;
    expect(operation.status).toBe("failed");
    expect(operation.error).toMatch(/boom/);
    expect(operation.result).toMatchObject({
      entities: { action: { errors: 1 } },
    });
    expect(
      stores.events.some(
        (e) => e.step === "mark-failed" && e.outcome === "failed",
      ),
    ).toBe(true);
  });

  it("fails a missing operation row without calling the transport", async () => {
    const stores = fakeStores();
    let called = false;

    await expect(
      runSyncDefaultsOperation(
        {
          stores,
          syncConfig: async () => {
            called = true;
            return applyResult();
          },
        },
        {
          operation_id: "op_missing",
          tenant_id: "kvartal",
          kind: "sync-defaults",
        },
        fakeStepRunner(),
      ),
    ).rejects.toThrow(/not found/);
    expect(called).toBe(false);
  });

  it("does not re-run a step the engine already completed (replay after eviction)", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    let syncs = 0;
    const deps = {
      stores,
      syncConfig: async () => {
        syncs++;
        return applyResult();
      },
    };
    const memo = new Map<string, unknown>();

    await runSyncDefaultsOperation(deps, params, replayStepRunner(memo));
    const replay = replayStepRunner(memo);
    await runSyncDefaultsOperation(deps, params, replay);

    expect(syncs).toBe(1);
    expect(replay.executed).toEqual([]);
  });

  it("keeps step outputs JSON-serialisable", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    const step = fakeStepRunner();

    await runSyncDefaultsOperation(
      { stores, syncConfig: async () => applyResult() },
      params,
      step,
    );

    expect(() =>
      JSON.stringify(stores.operations.get(params.operation_id)?.result),
    ).not.toThrow();
  });
});
