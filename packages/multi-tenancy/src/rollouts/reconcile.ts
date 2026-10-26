import { LogTypes } from "authhero";
import { DEFAULT_ROLLOUT_SETTINGS } from "./config";
import { listSyncedDescendants } from "./enumerate";
import { createExpectedHash, resolveLegacyParent } from "./hashes";
import {
  OPEN_ROLLOUT_STATUSES,
  listRolloutOperations,
  planRollout,
  rolloutsOf,
} from "./plan";
import type { RolloutDeps } from "./types";
import { isTerminalStatus } from "../operations";

export interface ReconcileConfigDriftOptions {
  /** The tenant whose descendants are checked. Defaults to the control plane. */
  rootTenantId?: string;
  /** Most tenants to report and roll out in one call. @default 500 */
  limit?: number;
  logger?: Pick<Console, "warn">;
}

export interface ReconcileConfigDriftResult {
  /** Synced tenants compared. */
  checked: number;
  /** Tenants whose applied hash differs from what their chain publishes. */
  drifted: number;
  /** Drifted tenants a running rollout already covers. */
  alreadyCovered: number;
  /** The rollout created for the rest, if any. */
  rolloutId?: string;
}

/**
 * The safety net for lost triggers (design 4.3): compares every synced
 * tenant's applied hash with the hash its chain would produce now. Drifted
 * tenants get a `cfgdrift` log (queryable per tenant) and, unless an open
 * rollout already covers them, one new rollout. Idempotent: running it again
 * before the rollout finishes creates nothing, and once the tenants are synced
 * there is nothing left to find.
 *
 * Run it from a scheduled handler, followed by `advanceRollouts`.
 */
export async function reconcileConfigDrift(
  deps: RolloutDeps,
  options: ReconcileConfigDriftOptions = {},
): Promise<ReconcileConfigDriftResult> {
  const rollouts = rolloutsOf(deps);
  const root = options.rootTenantId ?? deps.controlPlaneTenantId;
  const limit = options.limit ?? 500;

  const candidates = await listSyncedDescendants(deps.adapters, root, {
    resolveLegacyParent: (tenantId) => resolveLegacyParent(deps, tenantId),
    maxDepth: deps.maxDepth,
  });
  const expectedHash = createExpectedHash(deps);

  const drifted: Array<{
    tenantId: string;
    expected: string;
    applied: string | null;
  }> = [];
  for (const candidate of candidates) {
    if (drifted.length >= limit) break;
    try {
      const expected = await expectedHash(candidate.tenantId);
      if (candidate.appliedHash !== expected) {
        drifted.push({
          tenantId: candidate.tenantId,
          expected,
          applied: candidate.appliedHash,
        });
      }
    } catch (error) {
      options.logger?.warn(
        `Could not compute the expected hash of ${candidate.tenantId}:`,
        error,
      );
    }
  }

  const result: ReconcileConfigDriftResult = {
    checked: candidates.length,
    drifted: drifted.length,
    alreadyCovered: 0,
  };
  if (drifted.length === 0) return result;

  // Tenants an open rollout still has unfinished work for.
  const covered = new Set<string>();
  const { rollouts: open } = await rollouts.list({
    kind: "config-sync",
    status: [...OPEN_ROLLOUT_STATUSES],
    per_page: 100,
  });
  for (const rollout of open) {
    for (const operation of await listRolloutOperations(deps, rollout.id)) {
      if (operation.tenant_id && !isTerminalStatus(operation.status)) {
        covered.add(operation.tenant_id);
      }
    }
  }

  for (const entry of drifted) {
    try {
      await deps.adapters.logs.create(entry.tenantId, {
        type: LogTypes.CONFIG_DRIFT,
        date: new Date(deps.now?.() ?? Date.now()).toISOString(),
        isMobile: false,
        description: entry.applied
          ? "hash-mismatch: applied config differs from what the parent chain publishes"
          : "never-synced: no config has been applied to this synced tenant",
        details: {
          reason: entry.applied ? "hash-mismatch" : "never-synced",
          applied_hash: entry.applied,
          expected_hash: entry.expected,
          covered_by_open_rollout: covered.has(entry.tenantId),
          trigger: "reconcile",
        },
      });
    } catch (error) {
      options.logger?.warn(
        `Could not record drift for ${entry.tenantId}:`,
        error,
      );
    }
  }

  const uncovered = drifted.filter((d) => !covered.has(d.tenantId));
  result.alreadyCovered = drifted.length - uncovered.length;
  if (uncovered.length === 0) return result;

  const rollout = await rollouts.create({
    kind: "config-sync",
    initiated_by: "reconcile",
    config: {
      ...DEFAULT_ROLLOUT_SETTINGS,
      trigger: "reconcile",
      root_tenant_id: root,
      planned: false,
    },
  });
  await planRollout(deps, rollout, {
    tenantIds: uncovered.map((d) => d.tenantId),
  });
  result.rolloutId = rollout.id;
  return result;
}
