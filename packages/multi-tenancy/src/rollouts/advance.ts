import type { Rollout, TenantOperation } from "authhero";
import { createOperationRecorder, isTerminalStatus } from "../operations";
import { readRolloutConfig, type ConfigSyncRolloutConfig } from "./config";
import {
  OPEN_ROLLOUT_STATUSES,
  listRolloutOperations,
  planRollout,
  rolloutsOf,
  storesOf,
} from "./plan";
import type { RolloutDeps } from "./types";

export type RolloutTickOutcome =
  | "skipped"
  | "waiting"
  | "planned-empty"
  | "paused"
  | "started"
  | "running"
  | "done";

export interface RolloutTickResult {
  rolloutId: string;
  outcome: RolloutTickOutcome;
  /** Operations started by this tick. */
  started: number;
  /** The wave being worked on, when there is one. */
  wave?: number;
}

const waveOf = (operation: TenantOperation): number => {
  const wave = (operation.input as { wave?: unknown } | null)?.wave;
  return typeof wave === "number" ? wave : 0;
};

const isFailed = (operation: TenantOperation) =>
  operation.status === "failed" || operation.status === "cancelled";

/**
 * Why a finished wave is unhealthy, or null. Wave 0 is the canary only when
 * the rollout has one; it tolerates no failure, other waves tolerate
 * `failure_threshold`.
 */
function waveBreach(
  config: ConfigSyncRolloutConfig,
  operations: TenantOperation[],
  wave: number,
): string | null {
  const inWave = operations.filter((op) => waveOf(op) === wave);
  const failed = inWave.filter(isFailed).length;
  const isCanary = wave === 0 && config.canary > 0;
  const threshold = isCanary ? 0 : config.failure_threshold;
  if (
    inWave.length === 0 ||
    failed === 0 ||
    failed / inWave.length <= threshold
  )
    return null;
  return `${isCanary ? "canary" : `wave ${wave}`} failed for ${failed} of ${inWave.length} tenant(s)`;
}

/**
 * Advances one rollout by one step. Stateless and idempotent: all state is the
 * rollout row and its operations, so a tick can run from a cron, after a
 * request, or twice at once.
 *
 *  1. A write-triggered rollout waits out its debounce, then is planned.
 *  2. The current wave is the lowest one with unfinished operations. Before it
 *     starts, the previous wave is checked: the canary pauses the rollout on any
 *     failure, later waves when the failed fraction exceeds the threshold.
 *  3. Up to `max_concurrent` pending operations of the current wave are started.
 *  4. When every operation is finished the rollout is `done`.
 */
export async function advanceRollout(
  deps: RolloutDeps,
  rolloutOrId: Rollout | string,
): Promise<RolloutTickResult> {
  const rollouts = rolloutsOf(deps);
  const now = deps.now?.() ?? Date.now();

  let rollout =
    typeof rolloutOrId === "string"
      ? await rollouts.get(rolloutOrId)
      : rolloutOrId;
  if (!rollout || rollout.kind !== "config-sync") {
    return {
      rolloutId: String(rollout?.id ?? rolloutOrId),
      outcome: "skipped",
      started: 0,
    };
  }
  const id = rollout.id;
  if (
    !(OPEN_ROLLOUT_STATUSES as readonly string[]).includes(rollout.status) ||
    rollout.status === "paused"
  ) {
    return { rolloutId: id, outcome: "skipped", started: 0 };
  }

  let config = readRolloutConfig(rollout);

  // 1. A request that is still collecting writes.
  if (!config.planned) {
    const quietFor = now - Date.parse(rollout.updated_at);
    if (quietFor < config.debounce_ms) {
      return { rolloutId: id, outcome: "waiting", started: 0 };
    }
    const { planned } = await planRollout(deps, rollout);
    if (planned === 0)
      return { rolloutId: id, outcome: "planned-empty", started: 0 };
    rollout = (await rollouts.get(id)) ?? rollout;
    config = readRolloutConfig(rollout);
  }

  const operations = await listRolloutOperations(deps, id);
  const unfinished = operations.filter((op) => !isTerminalStatus(op.status));

  // 4. Nothing left to do, unless the last wave itself was unhealthy.
  if (unfinished.length === 0) {
    const last = Math.max(0, ...operations.map(waveOf));
    const breach =
      operations.length > 0 && last > (config.accepted_through ?? -1)
        ? waveBreach(config, operations, last)
        : null;
    await rollouts.update(id, {
      status: breach ? "failed" : "done",
      ...(breach ? { paused_reason: breach } : {}),
      finished_at: new Date(now).toISOString(),
    });
    return { rolloutId: id, outcome: "done", started: 0 };
  }

  // 2. The current wave and the gate in front of it.
  const wave = Math.min(...unfinished.map(waveOf));
  const previous = wave - 1;
  if (previous >= 0 && previous > (config.accepted_through ?? -1)) {
    const breach = waveBreach(config, operations, previous);
    if (breach) {
      await rollouts.update(id, { status: "paused", paused_reason: breach });
      return { rolloutId: id, outcome: "paused", started: 0, wave };
    }
  }

  const status = wave === 0 ? "canary" : "rolling";
  if (rollout.status !== status) await rollouts.update(id, { status });

  // 3. Start what fits.
  const inWave = unfinished.filter((op) => waveOf(op) === wave);
  const running = inWave.filter((op) => op.status === "running").length;
  const slots = Math.max(0, config.max_concurrent - running);
  const { tenantOperations, tenantOperationEvents } = storesOf(deps);
  const recorder = createOperationRecorder({
    tenantOperations,
    tenantOperationEvents,
  });
  let started = 0;
  for (const operation of inWave
    .filter((op) => op.status === "pending")
    .slice(0, slots)) {
    // Reserve it first: an executor that returns before the operation runs
    // (Workflows) would otherwise leave it `pending` for the next tick to pick
    // up again, and it would not count against `max_concurrent`.
    try {
      await recorder.markRunning(operation.id);
      await deps.executor.start(operation);
    } catch (error) {
      // The wave gate judges the failure once the wave is finished.
      try {
        const current = await tenantOperations.get(operation.id);
        if (current && !isTerminalStatus(current.status)) {
          await recorder.markFailed(operation.id, error);
        }
      } catch {
        // The store is broken; the next tick sees whatever state it left.
      }
    }
    started++;
  }

  return {
    rolloutId: id,
    outcome: started > 0 ? "started" : "running",
    started,
    wave,
  };
}

export interface AdvanceRolloutsOptions {
  /** Most rollouts to advance in one call. @default 20 */
  limit?: number;
  logger?: Pick<Console, "warn">;
}

/**
 * Advances every open `config-sync` rollout one step. Meant for a host's
 * scheduled handler (every few minutes). A rollout that throws does not stop
 * the others.
 */
export async function advanceRollouts(
  deps: RolloutDeps,
  options: AdvanceRolloutsOptions = {},
): Promise<RolloutTickResult[]> {
  const rollouts = rolloutsOf(deps);
  const { rollouts: open } = await rollouts.list({
    kind: "config-sync",
    status: ["pending", "canary", "rolling"],
    per_page: options.limit ?? 20,
  });

  const results: RolloutTickResult[] = [];
  for (const rollout of open) {
    try {
      results.push(await advanceRollout(deps, rollout));
    } catch (error) {
      options.logger?.warn(`Advancing rollout ${rollout.id} failed:`, error);
    }
  }
  return results;
}

/** Pauses a rollout; nothing further is started until it is resumed. */
export async function pauseRollout(
  deps: RolloutDeps,
  rolloutId: string,
  reason = "paused by an operator",
): Promise<Rollout | null> {
  const rollouts = rolloutsOf(deps);
  const rollout = await rollouts.get(rolloutId);
  if (!rollout || rollout.kind !== "config-sync") return null;
  if (rollout.status === "done" || rollout.status === "failed") return rollout;
  await rollouts.update(rolloutId, { status: "paused", paused_reason: reason });
  return rollouts.get(rolloutId);
}

/**
 * Resumes a paused rollout, accepting the failures that paused it: the waves
 * finished so far are no longer checked, and the next wave starts on the next
 * tick. Tenants that failed are picked up again by the next drift reconcile.
 */
export async function resumeRollout(
  deps: RolloutDeps,
  rolloutId: string,
): Promise<Rollout | null> {
  const rollouts = rolloutsOf(deps);
  const rollout = await rollouts.get(rolloutId);
  if (!rollout || rollout.kind !== "config-sync") return null;
  if (rollout.status !== "paused") return rollout;

  const config = readRolloutConfig(rollout);
  const operations = await listRolloutOperations(deps, rolloutId);
  const unfinished = operations.filter((op) => !isTerminalStatus(op.status));
  const wave = unfinished.length > 0 ? Math.min(...unfinished.map(waveOf)) : 0;

  await rollouts.update(rolloutId, {
    status: wave === 0 ? "canary" : "rolling",
    paused_reason: null,
    config: {
      ...config,
      accepted_through: Math.max(config.accepted_through ?? -1, wave - 1),
    },
  });
  return rollouts.get(rolloutId);
}
