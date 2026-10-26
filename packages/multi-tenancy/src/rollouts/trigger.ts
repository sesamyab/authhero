import type { Rollout } from "authhero";
import { effectiveScope } from "../inheritance/merge";
import type { ConfigEntity } from "../inheritance/types";
import { DEFAULT_ROLLOUT_SETTINGS, readRolloutConfig } from "./config";
import { rolloutsOf } from "./plan";
import type { RolloutDeps } from "./types";

/** The entities whose writes can change what descendants should hold. */
export type PublishableEntity =
  | ConfigEntity
  // Hook code has no scope of its own: it travels with the hooks that use it.
  | "hookCode";

/**
 * Whether a written row is something a parent publishes. A row counts when it
 * is shared or platform scoped, which for rows nobody has annotated follows
 * what read-time inheritance does today (system resource servers and actions,
 * inheritable hooks, connections and the email provider). Hook code always
 * counts, since it cannot be told from the code of an unpublished hook.
 */
export function isPublishedRow(
  entity: PublishableEntity,
  row: unknown,
): boolean {
  if (entity === "hookCode") return true;
  if (!row || typeof row !== "object") return false;
  return (
    effectiveScope(entity, row as Parameters<typeof effectiveScope>[1]) !==
    "local"
  );
}

/**
 * Records that `originTenantId` published a change (the write trigger). Writes
 * are coalesced through the rollout row itself: if a write-triggered rollout
 * for this origin is still waiting out its debounce it is touched (its
 * `updated_at` moves), otherwise one is created. The tick plans it once writes
 * have been quiet for `debounce_ms`. Cheap, durable, and safe to call from a
 * request: nothing is rolled out here.
 */
export async function requestRollout(
  deps: RolloutDeps,
  originTenantId: string,
  initiatedBy?: string,
): Promise<Rollout> {
  const rollouts = rolloutsOf(deps);

  const { rollouts: waiting } = await rollouts.list({
    kind: "config-sync",
    status: "pending",
    per_page: 100,
  });
  const existing = waiting.find((rollout) => {
    const config = readRolloutConfig(rollout);
    return (
      config.trigger === "write" &&
      config.planned !== true &&
      config.origin_tenant_id === originTenantId
    );
  });
  if (existing) {
    await rollouts.update(existing.id, {});
    return (await rollouts.get(existing.id)) ?? existing;
  }

  return rollouts.create({
    kind: "config-sync",
    initiated_by: initiatedBy ?? `write:${originTenantId}`,
    config: {
      ...DEFAULT_ROLLOUT_SETTINGS,
      trigger: "write",
      // A change reaches the origin's own subtree.
      root_tenant_id: originTenantId,
      origin_tenant_id: originTenantId,
      planned: false,
    },
  });
}

/** The entity hooks that turn a published write into a rollout request. */
export interface RolloutWriteHooks {
  actions: EntityWriteHooks;
  hooks: EntityWriteHooks;
  hookCode: EntityWriteHooks;
  connections: EntityWriteHooks;
  resourceServers: EntityWriteHooks;
}

interface EntityWriteHooks {
  afterCreate: (ctx: { tenantId: string }, entity: unknown) => Promise<void>;
  afterUpdate: (
    ctx: { tenantId: string },
    id: string,
    entity: unknown,
  ) => Promise<void>;
  afterDelete: (ctx: { tenantId: string }, id: string) => Promise<void>;
}

/**
 * Whether anything could be below `tenantId`: the control plane always, any
 * other tenant when some tenant names it as its parent. A guess is fine: a
 * request that finds nothing to roll out disappears when it is planned.
 */
async function mayHaveSubtree(
  deps: RolloutDeps,
  tenantId: string,
): Promise<boolean> {
  if (tenantId === deps.controlPlaneTenantId) return true;
  try {
    const { tenants } = await deps.adapters.tenants.list({
      q: `parent_tenant_id:${tenantId}`,
      per_page: 1,
    });
    return tenants.some((t) => t.parent_tenant_id === tenantId);
  } catch {
    return true;
  }
}

/**
 * Entity hooks for the write trigger (design 4.3, trigger 1). After a published
 * row is created, updated or deleted, `requestRollout` records the change; a
 * burst of writes becomes one rollout. A failure here never fails the write:
 * the drift reconcile finds whatever a lost request would have rolled out.
 */
export function createRolloutWriteHooks(
  deps: RolloutDeps,
  options: { logger?: Pick<Console, "warn"> } = {},
): RolloutWriteHooks {
  const request = async (tenantId: string) => {
    try {
      if (await mayHaveSubtree(deps, tenantId)) {
        await requestRollout(deps, tenantId);
      }
    } catch (error) {
      options.logger?.warn(
        `Could not record a config change for ${tenantId}:`,
        error,
      );
    }
  };

  const forEntity = (entity: PublishableEntity): EntityWriteHooks => ({
    afterCreate: async (ctx, row) => {
      if (isPublishedRow(entity, row)) await request(ctx.tenantId);
    },
    afterUpdate: async (ctx, _id, row) => {
      if (isPublishedRow(entity, row)) await request(ctx.tenantId);
    },
    // The row is gone, so whether it was published is unknown: ask anyway.
    afterDelete: async (ctx) => request(ctx.tenantId),
  });

  return {
    actions: forEntity("action"),
    hooks: forEntity("hook"),
    hookCode: forEntity("hookCode"),
    connections: forEntity("connection"),
    resourceServers: forEntity("resourceServer"),
  };
}
