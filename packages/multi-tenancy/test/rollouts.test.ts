import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import {
  advanceRollout,
  advanceRollouts,
  assignWaves,
  createInProcessSyncConfig,
  createInlineExecutor,
  createOperationRecorder,
  createRolloutController,
  isPublishedRow,
  listSyncedDescendants,
  planRollout,
  reconcileConfigDrift,
  requestRollout,
  runSyncDefaultsStep,
  type RolloutDeps,
  type SyncConfigFn,
} from "../src";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";

describe("assignWaves", () => {
  const sizes = (assignment: number[]) =>
    assignment.reduce<number[]>((acc, wave) => {
      acc[wave] = (acc[wave] ?? 0) + 1;
      return acc;
    }, []);

  it("puts the canary first, then one wave per percentage step", () => {
    expect(sizes(assignWaves(20, 1, [10, 50, 100]))).toEqual([1, 1, 8, 10]);
    expect(sizes(assignWaves(5, 1, [50, 100]))).toEqual([1, 2, 2]);
  });

  it("copes with tiny fleets, no canary and short plans", () => {
    expect(assignWaves(0, 1, [100])).toEqual([]);
    expect(assignWaves(1, 1, [10, 100])).toEqual([0]);
    expect(sizes(assignWaves(4, 0, [100]))).toEqual([4]);
    // Percentages that do not reach 100 still end at the last tenant.
    expect(sizes(assignWaves(10, 1, [20]))).toEqual([1, 1, 8]);
    // A canary larger than the fleet is the whole fleet.
    expect(sizes(assignWaves(2, 5, [100]))).toEqual([2]);
  });
});

describe("fleet rollouts", () => {
  let db: Kysely<Database>;
  let adapters: ReturnType<typeof createAdapters>;
  let failing: Set<string>;
  let deps: RolloutDeps;
  let clock: number;

  const syncConfig: SyncConfigFn = async (tenantId, options) => {
    if (failing.has(tenantId)) throw new Error(`sync of ${tenantId} failed`);
    return createInProcessSyncConfig(adapters, { controlPlaneTenantId: CP })(
      tenantId,
      options,
    );
  };

  function makeDeps(): RolloutDeps {
    const stores = {
      tenantOperations: adapters.tenantOperations,
      tenantOperationEvents: adapters.tenantOperationEvents,
    };
    const recorder = createOperationRecorder(stores);
    const executor = createInlineExecutor({
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
    return {
      adapters,
      executor,
      controlPlaneTenantId: CP,
      now: () => clock,
    };
  }

  async function addTenant(
    id: string,
    extra: Record<string, unknown> = { config_sync: "synced" },
  ) {
    await adapters.tenants.create({ id, friendly_name: id, ...extra });
  }

  const hashOf = async (id: string) =>
    (await adapters.tenants.get(id))?.config_sync_hash;

  async function addFleet(count: number, prefix = "t") {
    const ids = Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
    for (const id of ids) await addTenant(id);
    return ids;
  }

  const tick = async (id: string) => advanceRollout(deps, id);
  const operationsOf = async (rolloutId: string) =>
    (
      await adapters.tenantOperations.list({
        rollout_id: rolloutId,
        per_page: 200,
      })
    ).operations;

  beforeEach(async () => {
    db = await createMigratedDb();
    adapters = createAdapters(db);
    failing = new Set();
    clock = Date.now();
    deps = makeDeps();
    await adapters.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await adapters.actions.create(CP, {
      name: "enrich",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "shared",
    });
  });

  describe("enumeration", () => {
    it("lists synced descendants, parents before children, skipping the rest", async () => {
      await addTenant("b-top");
      await addTenant("a-top");
      await addTenant("kid", {
        config_sync: "synced",
        parent_tenant_id: "a-top",
      });
      await addTenant("inheriting", { config_sync: "inherit-on-read" });
      await addTenant("unset", {});

      const found = await listSyncedDescendants(adapters, CP, {
        resolveLegacyParent: async () => CP,
      });

      expect(found.map((f) => [f.tenantId, f.depth])).toEqual([
        ["a-top", 1],
        ["b-top", 1],
        ["kid", 2],
      ]);
    });

    it("scopes to a subtree and honours a per-tenant opt-out of the implicit parent", async () => {
      await addTenant("a-top");
      await addTenant("kid", {
        config_sync: "synced",
        parent_tenant_id: "a-top",
      });
      await addTenant("b-top");
      await addTenant("isolated");

      expect(
        (
          await listSyncedDescendants(adapters, "a-top", {
            resolveLegacyParent: async () => CP,
          })
        ).map((f) => f.tenantId),
      ).toEqual(["kid"]);

      const found = await listSyncedDescendants(adapters, CP, {
        resolveLegacyParent: async (id) => (id === "isolated" ? undefined : CP),
      });
      expect(found.map((f) => f.tenantId)).not.toContain("isolated");
    });
  });

  describe("waves, pause and resume", () => {
    it("rolls a fleet out canary first, then in waves, until done", async () => {
      const ids = await addFleet(5);
      const controller = createRolloutController(deps);

      const rollout = await controller.create({ canary: 1, waves: [50, 100] });
      expect(rollout.status).toBe("canary");
      expect(rollout.config).toMatchObject({ planned: true, tenant_count: 5 });

      // Planning created one operation per tenant, in waves 0, 1, 1, 2, 2; the
      // create call already ran the canary.
      let operations = await operationsOf(rollout.id);
      expect(operations).toHaveLength(5);
      expect(
        operations.map((o) => (o.input as { wave: number }).wave).sort(),
      ).toEqual([0, 1, 1, 2, 2]);
      expect(await hashOf("t1")).toBeTruthy();
      expect(await hashOf("t2")).toBeUndefined();

      expect((await tick(rollout.id)).wave).toBe(1);
      expect(await hashOf("t2")).toBeTruthy();
      expect(await hashOf("t4")).toBeUndefined();

      expect((await tick(rollout.id)).wave).toBe(2);
      for (const id of ids) expect(await hashOf(id)).toBeTruthy();

      expect((await tick(rollout.id)).outcome).toBe("done");
      const done = await adapters.rollouts!.get(rollout.id);
      expect(done?.status).toBe("done");
      expect(done?.finished_at).toBeTruthy();

      operations = await operationsOf(rollout.id);
      expect(operations.every((o) => o.status === "succeeded")).toBe(true);
      expect(operations.every((o) => o.rollout_id === rollout.id)).toBe(true);
    });

    it("pauses when the canary fails, and resumes to the next wave", async () => {
      await addFleet(4);
      failing.add("t1");
      const controller = createRolloutController(deps);
      const rollout = await controller.create({ canary: 1, waves: [100] });

      const paused = await tick(rollout.id);
      expect(paused.outcome).toBe("paused");
      const row = await adapters.rollouts!.get(rollout.id);
      expect(row?.status).toBe("paused");
      expect(row?.paused_reason).toMatch(/canary failed for 1 of 1/);
      // Nothing from wave 1 started.
      expect(await hashOf("t2")).toBeUndefined();
      expect((await tick(rollout.id)).outcome).toBe("skipped");

      const resumed = await controller.resume(rollout.id);
      expect(resumed?.status).toBe("rolling");
      expect(resumed?.paused_reason).toBeNull();

      expect((await tick(rollout.id)).wave).toBe(1);
      expect(await hashOf("t2")).toBeTruthy();
      expect(await hashOf("t4")).toBeTruthy();
      expect(await hashOf("t1")).toBeUndefined();
      expect((await tick(rollout.id)).outcome).toBe("done");
    });

    it("pauses a later wave above the failure threshold and not below it", async () => {
      // Canary 1, then 5, then 5.
      const run = async (failureThreshold: number) => {
        db = await createMigratedDb();
        adapters = createAdapters(db);
        deps = makeDeps();
        await adapters.tenants.create({
          id: CP,
          friendly_name: "Control Plane",
        });
        await adapters.actions.create(CP, {
          name: "enrich",
          code: "// c",
          scope: "shared",
        });
        await addFleet(11);
        failing = new Set(["t3"]); // one of wave 1
        const rollout = await createRolloutController(deps).create({
          canary: 1,
          waves: [50, 100],
          failureThreshold,
        });
        await tick(rollout.id); // wave 1
        return { rollout, next: await tick(rollout.id) }; // gate in front of wave 2
      };

      const strict = await run(0.1);
      expect(strict.next.outcome).toBe("paused");
      expect(
        (await adapters.rollouts!.get(strict.rollout.id))?.paused_reason,
      ).toMatch(/wave 1 failed for 1 of 5/);

      const lenient = await run(0.25);
      expect(lenient.next.outcome).not.toBe("paused");
      expect(lenient.next.wave).toBe(2);
    });

    it("starts at most max_concurrent operations per tick", async () => {
      await addFleet(5);
      const rollout = await createRolloutController(deps).create({
        canary: 0,
        waves: [100],
        maxConcurrent: 2,
      });

      const syncedCount = async () => {
        let n = 0;
        for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
          if (await hashOf(id)) n++;
        }
        return n;
      };
      expect(await syncedCount()).toBe(2);
      await tick(rollout.id);
      expect(await syncedCount()).toBe(4);
      await tick(rollout.id);
      expect(await syncedCount()).toBe(5);
    });

    it("is idempotent: a tick with nothing to do starts nothing", async () => {
      await addFleet(2);
      const rollout = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
      });
      await tick(rollout.id);
      expect((await tick(rollout.id)).outcome).toBe("done");

      const again = await tick(rollout.id);
      expect(again).toMatchObject({ outcome: "skipped", started: 0 });
      expect(await operationsOf(rollout.id)).toHaveLength(2);
    });

    it("leaves tenants that are already up to date out of a rollout, unless forced", async () => {
      await addFleet(3);
      await syncConfig("t1", { dryRun: false, force: false });

      const rollout = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
      });
      expect(
        (await operationsOf(rollout.id)).map((o) => o.tenant_id).sort(),
      ).toEqual(["t2", "t3"]);

      const forced = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
        force: true,
      });
      expect(await operationsOf(forced.id)).toHaveLength(3);
    });

    it("rolls a parent out before its children", async () => {
      await addTenant("mid");
      await addTenant("kid", {
        config_sync: "synced",
        parent_tenant_id: "mid",
      });
      const rollout = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
      });

      // The canary is the shallowest tenant.
      expect(await hashOf("mid")).toBeTruthy();
      expect(await hashOf("kid")).toBeUndefined();
      await tick(rollout.id);
      expect(await hashOf("kid")).toBeTruthy();
    });

    it("records a dry run without writing anything", async () => {
      await addFleet(2);
      const rollout = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
        dryRun: true,
      });
      await tick(rollout.id);
      await tick(rollout.id);

      expect(await hashOf("t1")).toBeUndefined();
      expect((await adapters.actions.list("t1")).actions).toHaveLength(0);
      const operations = await operationsOf(rollout.id);
      expect(operations.every((o) => o.status === "succeeded")).toBe(true);
      expect(operations[0]!.result).toMatchObject({
        dry_run: true,
        status: "dry-run",
      });
    });

    it("ends a rollout with nothing to do as done", async () => {
      const rollout = await createRolloutController(deps).create({});
      expect(rollout.status).toBe("done");
      expect(rollout.config).toMatchObject({ tenant_count: 0 });
    });

    it("limits a rollout to the requested tenants", async () => {
      await addFleet(3);
      const rollout = await createRolloutController(deps).create({
        tenantIds: ["t2", "not-a-tenant"],
        canary: 1,
        waves: [100],
      });
      expect((await operationsOf(rollout.id)).map((o) => o.tenant_id)).toEqual([
        "t2",
      ]);
    });
  });

  describe("write trigger", () => {
    it("coalesces a burst of writes into one rollout and plans it after the quiet period", async () => {
      await addFleet(2);

      const first = await requestRollout(deps, CP);
      clock += 10_000;
      const second = await requestRollout(deps, CP);
      expect(second.id).toBe(first.id);
      expect(
        (await adapters.rollouts!.list({ kind: "config-sync" })).rollouts,
      ).toHaveLength(1);
      expect(first.config).toMatchObject({ trigger: "write", planned: false });

      // Still inside the debounce window.
      expect((await tick(first.id)).outcome).toBe("waiting");
      expect(await operationsOf(first.id)).toHaveLength(0);

      // The quiet period is measured from the last touch (the real clock for
      // `updated_at`), so move well past it.
      deps = { ...deps, now: () => Date.now() + 3_600_000 };
      const planned = await advanceRollout(deps, first.id);
      expect(planned.outcome).toBe("started");
      expect(await operationsOf(first.id)).toHaveLength(2);
    });

    it("removes a write-triggered rollout that finds nothing to do", async () => {
      await addFleet(1);
      await syncConfig("t1", { dryRun: false, force: false });
      const request = await requestRollout(deps, CP);

      deps = { ...deps, now: () => Date.now() + 3_600_000 };
      const result = await advanceRollout(deps, request.id);

      expect(result.outcome).toBe("planned-empty");
      expect(await adapters.rollouts!.get(request.id)).toBeNull();
    });

    it("treats scoped and legacy-published rows as published, and local ones not", () => {
      expect(isPublishedRow("action", { scope: "shared" })).toBe(true);
      expect(isPublishedRow("action", { scope: "platform" })).toBe(true);
      expect(isPublishedRow("action", {})).toBe(false);
      expect(isPublishedRow("action", { is_system: true })).toBe(true);
      expect(isPublishedRow("hook", { metadata: { inheritable: true } })).toBe(
        true,
      );
      expect(isPublishedRow("connection", {})).toBe(true);
      expect(isPublishedRow("connection", { scope: "local" })).toBe(false);
      expect(isPublishedRow("hookCode", {})).toBe(true);
      expect(isPublishedRow("action", null)).toBe(false);
    });
  });

  describe("drift reconcile", () => {
    it("catches a change whose trigger was lost, and rolls it out once", async () => {
      const ids = await addFleet(3);
      const first = await createRolloutController(deps).create({
        canary: 1,
        waves: [100],
      });
      await tick(first.id);
      await tick(first.id);
      expect((await adapters.rollouts!.get(first.id))?.status).toBe("done");
      expect((await reconcileConfigDrift(deps)).drifted).toBe(0);

      // The control plane publishes a change, and nothing triggers a rollout.
      const [action] = (await adapters.actions.list(CP)).actions;
      await adapters.actions.update(CP, action!.id, {
        code: "exports.onExecutePostLogin = async () => { /* v2 */ };",
      });

      const result = await reconcileConfigDrift(deps);
      expect(result).toMatchObject({
        checked: 3,
        drifted: 3,
        alreadyCovered: 0,
      });
      expect(result.rolloutId).toBeTruthy();

      // Each drifted tenant has a queryable drift event.
      for (const id of ids) {
        const { logs } = await adapters.logs.list(id, { q: "type:cfgdrift" });
        expect(logs).toHaveLength(1);
        expect(logs[0]!.details).toMatchObject({
          reason: "hash-mismatch",
          trigger: "reconcile",
        });
        expect(JSON.stringify(logs[0]!.details)).not.toContain("v2");
      }

      // A second run before the rollout finishes finds the tenants covered.
      const again = await reconcileConfigDrift(deps);
      expect(again).toMatchObject({ drifted: 3, alreadyCovered: 3 });
      expect(again.rolloutId).toBeUndefined();
      expect(
        (
          await adapters.rollouts!.list({
            kind: "config-sync",
            status: ["canary"],
          })
        ).rollouts,
      ).toHaveLength(1);

      // Ticks bring every tenant to the new hash; nothing drifts afterwards.
      for (let i = 0; i < 6; i++) await advanceRollouts(deps);
      expect((await adapters.rollouts!.get(result.rolloutId!))?.status).toBe(
        "done",
      );
      expect((await reconcileConfigDrift(deps)).drifted).toBe(0);
      for (const id of ids) {
        const synced = (await adapters.actions.list(id)).actions[0];
        expect(synced?.code).toContain("v2");
      }
    });

    it("reports a synced tenant that was never synced", async () => {
      await addFleet(1);

      const result = await reconcileConfigDrift(deps);

      expect(result.drifted).toBe(1);
      const { logs } = await adapters.logs.list("t1", { q: "type:cfgdrift" });
      expect(logs[0]!.details).toMatchObject({
        reason: "never-synced",
        applied_hash: null,
      });
    });

    it("does not report tenants that are not synced", async () => {
      await addTenant("reads-on-demand", { config_sync: "inherit-on-read" });

      expect(await reconcileConfigDrift(deps)).toMatchObject({
        checked: 0,
        drifted: 0,
      });
    });

    it("is bounded by limit", async () => {
      await addFleet(4);
      const result = await reconcileConfigDrift(deps, { limit: 2 });
      expect(result.drifted).toBe(2);
    });
  });

  it("ticks every open rollout and survives one that throws", async () => {
    await addFleet(2, "a");
    const good = await createRolloutController(deps).create({
      canary: 1,
      waves: [100],
    });
    const warnings: unknown[] = [];

    const results = await advanceRollouts(deps, {
      logger: { warn: (...args: unknown[]) => void warnings.push(args) },
    });

    expect(results.map((r) => r.rolloutId)).toEqual([good.id]);
    expect(warnings).toHaveLength(0);
  });

  it("plans from a hand-made rollout row", async () => {
    await addFleet(2);
    const rollout = await adapters.rollouts!.create({
      kind: "config-sync",
      config: { trigger: "manual", root_tenant_id: CP },
    });

    const result = await planRollout(deps, rollout);

    expect(result.planned).toBe(2);
    expect((await adapters.rollouts!.get(rollout.id))?.status).toBe("canary");
  });
});
