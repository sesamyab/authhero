import type { Rollout } from "authhero";
import {
  DEFAULT_ROLLOUT_SETTINGS,
  type ConfigSyncRolloutConfig,
} from "./config";
import { advanceRollout, pauseRollout, resumeRollout } from "./advance";
import { planRollout, rolloutsOf } from "./plan";
import type { RolloutDeps } from "./types";

export interface CreateRolloutParams {
  /** Roll out to the synced descendants of this tenant. Defaults to the control plane. */
  rootTenantId?: string;
  /** Limit the rollout to these tenants (those that are synced descendants). */
  tenantIds?: string[];
  canary?: number;
  waves?: number[];
  failureThreshold?: number;
  /** Operations started per tick. */
  maxConcurrent?: number;
  dryRun?: boolean;
  force?: boolean;
  initiatedBy?: string;
}

export interface RolloutController {
  /** Plans a manual rollout and starts its canary. */
  create(params: CreateRolloutParams): Promise<Rollout>;
  pause(id: string, reason?: string): Promise<Rollout | null>;
  resume(id: string): Promise<Rollout | null>;
}

/**
 * The operations a management API needs on rollouts that go beyond reading and
 * updating rows. Wired by `initMultiTenant`, like the tenant operation
 * executor.
 */
export function createRolloutController(deps: RolloutDeps): RolloutController {
  return {
    async create(params) {
      const config: ConfigSyncRolloutConfig = {
        ...DEFAULT_ROLLOUT_SETTINGS,
        waves: params.waves ?? [...DEFAULT_ROLLOUT_SETTINGS.waves],
        canary: params.canary ?? DEFAULT_ROLLOUT_SETTINGS.canary,
        failure_threshold:
          params.failureThreshold ?? DEFAULT_ROLLOUT_SETTINGS.failure_threshold,
        max_concurrent:
          params.maxConcurrent ?? DEFAULT_ROLLOUT_SETTINGS.max_concurrent,
        trigger: "manual",
        root_tenant_id: params.rootTenantId ?? deps.controlPlaneTenantId,
        dry_run: params.dryRun,
        force: params.force,
        planned: false,
      };

      const rollouts = rolloutsOf(deps);
      const rollout = await rollouts.create({
        kind: "config-sync",
        initiated_by: params.initiatedBy,
        config: config as unknown as Record<string, unknown>,
      });
      await planRollout(deps, rollout, { tenantIds: params.tenantIds });
      // Start the canary right away; later waves follow on the next ticks.
      await advanceRollout(deps, rollout.id);
      return (await rollouts.get(rollout.id)) ?? rollout;
    },
    pause: (id, reason) => pauseRollout(deps, id, reason),
    resume: (id) => resumeRollout(deps, id),
  };
}
