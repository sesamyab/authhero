import { describe, it, expect } from "vitest";
import type { DetachResult } from "@authhero/multi-tenancy";
import { runDetachOperation } from "../../src/workflows";
import { fakeStepRunner, fakeStores } from "./helpers";

const outcome = (over: Partial<{ errors: string[] }> = {}) => ({
  converted: 0,
  removed: 0,
  skipped: 0,
  errors: [] as string[],
  ...over,
});

function detachResult(over: Partial<DetachResult> = {}): DetachResult {
  return {
    status: "detached",
    changes: ["convert action:enrich"],
    rows: [{ entity: "action", key: "enrich", action: "converted" }],
    entities: {
      connection: outcome(),
      resourceServer: outcome(),
      hookCode: outcome(),
      action: { ...outcome(), converted: 1 },
      hook: outcome(),
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
    kind: "detach",
    engine: "cloudflare-workflows",
    input,
  });
  return {
    operation_id: op.id,
    tenant_id: "kvartal",
    kind: "detach" as const,
  };
}

describe("runDetachOperation", () => {
  it("detaches the tenant, records the result and the step trail", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    const calls: Array<[string, unknown]> = [];
    const step = fakeStepRunner();

    await runDetachOperation(
      {
        stores,
        detachTenant: async (tenantId, options) => {
          calls.push([tenantId, options]);
          return detachResult();
        },
      },
      params,
      step,
    );

    expect(calls).toEqual([["kvartal", { dryRun: false, clean: false }]]);
    expect(step.calls.map((c) => c.name)).toEqual([
      "mark-running",
      "detach",
      "mark-succeeded",
    ]);
    const operation = stores.operations.get(params.operation_id)!;
    expect(operation.status).toBe("succeeded");
    expect(operation.result).toMatchObject({
      status: "detached",
      rows: [{ entity: "action", key: "enrich", action: "converted" }],
    });
  });

  it("passes dry_run and clean from the operation input", async () => {
    const stores = fakeStores();
    const params = await seed(stores, { dry_run: true, clean: true });
    const seen: unknown[] = [];

    await runDetachOperation(
      {
        stores,
        detachTenant: async (_tenantId, options) => {
          seen.push(options);
          return detachResult({ status: "dry-run" });
        },
      },
      params,
      fakeStepRunner(),
    );

    expect(seen).toEqual([{ dryRun: true, clean: true }]);
    expect(stores.operations.get(params.operation_id)?.result).toMatchObject({
      dry_run: true,
      clean: true,
      status: "dry-run",
    });
  });

  it("does not retry the detach step, but retries the bookkeeping steps, unless a host overrides it", async () => {
    const stores = fakeStores();
    const params = await seed(stores);
    const step = fakeStepRunner();

    await runDetachOperation(
      { stores, detachTenant: async () => detachResult() },
      params,
      step,
    );

    expect(
      step.calls.find((c) => c.name === "detach")?.config?.retries,
    ).toEqual({ limit: 0, delay: "5 seconds" });
    expect(
      step.calls.find((c) => c.name === "mark-running")?.config?.retries,
    ).toEqual({ limit: 3, delay: "5 seconds", backoff: "exponential" });

    const overridden = fakeStepRunner();
    await runDetachOperation(
      {
        stores,
        detachTenant: async () => detachResult(),
        stepConfig: { detach: { retries: { limit: 1, delay: 1 } } },
      },
      await seed(stores),
      overridden,
    );
    expect(
      overridden.calls.find((c) => c.name === "detach")?.config?.retries,
    ).toEqual({ limit: 1, delay: 1 });
  });

  it("fails the operation when rows report errors, and still records the result", async () => {
    const stores = fakeStores();
    const params = await seed(stores);

    await expect(
      runDetachOperation(
        {
          stores,
          detachTenant: async () =>
            detachResult({
              status: "partial",
              entities: {
                ...detachResult().entities,
                hook: outcome({ errors: ["h_sy1: boom"] }),
              },
            }),
        },
        params,
        fakeStepRunner(),
      ),
    ).rejects.toThrow(/detach reported 1 error/);

    const operation = stores.operations.get(params.operation_id)!;
    expect(operation.status).toBe("failed");
    expect(operation.result).toMatchObject({ status: "partial" });
  });
});
