import type { Rollout, TenantOperation } from "authhero";
import { createOperationRow } from "../operations";
import { assignWaves, readRolloutConfig } from "./config";
import { listSyncedDescendants } from "./enumerate";
import { createExpectedHash, resolveLegacyParent } from "./hashes";
import type { RolloutDeps } from "./types";

export const OPEN_ROLLOUT_STATUSES = [
  "pending",
  "canary",
  "rolling",
  "paused",
] as const;

export function storesOf(deps: RolloutDeps) {
  const { tenantOperations, tenantOperationEvents } = deps.adapters;
  if (!tenantOperations || !tenantOperationEvents) {
    throw new Error("Fleet rollouts need the tenant operations adapters");
  }
  return { tenantOperations, tenantOperationEvents };
}

export function rolloutsOf(deps: RolloutDeps) {
  if (!deps.adapters.rollouts) {
    throw new Error("Fleet rollouts need the rollouts adapter");
  }
  return deps.adapters.rollouts;
}

export interface PlanResult {
  /** Tenants that get a sync operation. */
  planned: number;
  /** Candidates left out because they are already up to date. */
  upToDate: number;
}

/**
 * Turns a rollout into per-tenant `sync-defaults` operations: lists the synced
 * descendants of the rollout's root (parents before children), leaves out the
 * ones whose stored hash already matches (unless `force`), splits the rest into
 * a canary and percentage waves, and creates one `pending` operation each. The
 * rollout's `config` records the result. A rollout with nothing to do ends
 * `done` (a write-triggered one, which exists only because something was
 * written, is removed instead of leaving noise).
 */
export async function planRollout(
  deps: RolloutDeps,
  rollout: Rollout,
  options: { tenantIds?: string[] } = {},
): Promise<PlanResult> {
  const rollouts = rolloutsOf(deps);
  const stores = storesOf(deps);
  const config = readRolloutConfig(rollout);

  let candidates = await listSyncedDescendants(
    deps.adapters,
    config.root_tenant_id,
    {
      resolveLegacyParent: (tenantId) => resolveLegacyParent(deps, tenantId),
      maxDepth: deps.maxDepth,
    },
  );
  if (options.tenantIds) {
    const wanted = new Set(options.tenantIds);
    candidates = candidates.filter((c) => wanted.has(c.tenantId));
  }

  const expectedHash = createExpectedHash(deps);
  const targets: typeof candidates = [];
  for (const candidate of candidates) {
    if (
      config.force ||
      candidate.appliedHash !== (await expectedHash(candidate.tenantId))
    ) {
      targets.push(candidate);
    }
  }
  const upToDate = candidates.length - targets.length;

  if (targets.length === 0) {
    if (config.trigger === "write") {
      await rollouts.remove(rollout.id);
    } else {
      await rollouts.update(rollout.id, {
        status: "done",
        finished_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        config: { ...config, planned: true, tenant_count: 0 },
      });
    }
    return { planned: 0, upToDate };
  }

  const waves = assignWaves(targets.length, config.canary, config.waves);
  for (const [index, target] of targets.entries()) {
    await createOperationRow(
      stores,
      {
        kind: "sync-defaults",
        tenant_id: target.tenantId,
        rollout_id: rollout.id,
        initiated_by: `rollout:${rollout.id}`,
        input: {
          wave: waves[index],
          ...(config.dry_run ? { dry_run: true } : {}),
          ...(config.force ? { force: true } : {}),
        },
      },
      deps.executor.engine,
    );
  }

  await rollouts.update(rollout.id, {
    status: "canary",
    config: { ...config, planned: true, tenant_count: targets.length },
  });
  return { planned: targets.length, upToDate };
}

/** Every operation of a rollout, oldest first. */
export async function listRolloutOperations(
  deps: RolloutDeps,
  rolloutId: string,
): Promise<TenantOperation[]> {
  const { tenantOperations } = storesOf(deps);
  const all: TenantOperation[] = [];
  const perPage = 200;
  for (let page = 0; ; page++) {
    const { operations } = await tenantOperations.list({
      rollout_id: rolloutId,
      page,
      per_page: perPage,
    });
    all.push(...operations);
    if (operations.length < perPage) break;
  }
  return all.sort((a, b) =>
    a.created_at === b.created_at
      ? a.id < b.id
        ? -1
        : 1
      : a.created_at < b.created_at
        ? -1
        : 1,
  );
}
