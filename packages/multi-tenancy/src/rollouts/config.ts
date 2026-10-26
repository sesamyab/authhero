import type { Rollout } from "authhero";

/**
 * Settings of a `config-sync` rollout, stored in the rollout's `config` column.
 * Waves are cumulative percentages of the rolled-out tenants; the canary is a
 * count that goes first. A wave is checked when it finishes: the canary pauses
 * the rollout on any failure, later waves when the failed fraction exceeds
 * `failure_threshold`.
 */
export interface ConfigSyncRolloutConfig {
  /** Tenants synced first, on their own. */
  canary: number;
  /** Cumulative percentages, ascending, ending at 100. */
  waves: number[];
  /** Failed fraction of a wave (0..1) above which the rollout pauses. */
  failure_threshold: number;
  /** Operations started per tick. */
  max_concurrent: number;
  /** Quiet time after the last write before a write-triggered rollout plans. */
  debounce_ms: number;

  /** What started it. */
  trigger: "write" | "reconcile" | "manual";
  /** The tenant whose descendants are rolled out to. */
  root_tenant_id: string;
  /** The tenant whose write requested it (write trigger). */
  origin_tenant_id?: string;
  /** Sync nothing, only report the diff. */
  dry_run?: boolean;
  /** Apply even when a tenant's stored hash matches. */
  force?: boolean;

  /** False while a write-triggered request waits out its debounce. */
  planned?: boolean;
  /** Tenants in the rollout, set when planned. */
  tenant_count?: number;
  /** Waves up to and including this one have been accepted by an operator. */
  accepted_through?: number;
}

export const DEFAULT_ROLLOUT_WAVES = [10, 50, 100];

export const DEFAULT_ROLLOUT_SETTINGS = {
  canary: 1,
  waves: DEFAULT_ROLLOUT_WAVES,
  failure_threshold: 0.1,
  max_concurrent: 25,
  debounce_ms: 60_000,
} as const;

/** Reads a rollout's config, filling defaults for anything missing. */
export function readRolloutConfig(
  rollout: Pick<Rollout, "config">,
): ConfigSyncRolloutConfig {
  const raw = (rollout.config ?? {}) as Partial<ConfigSyncRolloutConfig>;
  return {
    ...DEFAULT_ROLLOUT_SETTINGS,
    trigger: "manual",
    root_tenant_id: "",
    ...raw,
    waves:
      Array.isArray(raw.waves) && raw.waves.length > 0
        ? raw.waves
        : [...DEFAULT_ROLLOUT_WAVES],
  };
}

/**
 * Assigns each of `count` tenants (already in rollout order) to a wave: wave 0
 * is the canary, then one wave per percentage step. Boundaries are
 * `ceil(count * pct / 100)`; empty waves are dropped and the last wave always
 * reaches the end.
 */
export function assignWaves(
  count: number,
  canary: number,
  waves: number[],
): number[] {
  const assignment = new Array<number>(count).fill(0);
  if (count === 0) return assignment;

  const canarySize = Math.min(Math.max(canary, 0), count);
  const boundaries: number[] = [];
  let previous = canarySize;
  for (const pct of waves) {
    const boundary = Math.min(
      count,
      Math.max(previous, Math.ceil((count * pct) / 100)),
    );
    if (boundary > previous) {
      boundaries.push(boundary);
      previous = boundary;
    }
  }
  if (previous < count) boundaries.push(count);

  let wave = canarySize > 0 ? 1 : 0;
  let index = canarySize;
  for (const boundary of boundaries) {
    for (; index < boundary; index++) assignment[index] = wave;
    wave++;
  }
  return assignment;
}
