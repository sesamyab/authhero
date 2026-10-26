import { resolveTenantChain } from "../inheritance/chain";
import { buildResolvedConfigBlock } from "../rollout/resolved-sync";
import type { RolloutDeps } from "./types";

/** The tenant the sync would treat as the implicit parent of `tenantId`. */
export async function resolveLegacyParent(
  deps: Pick<RolloutDeps, "controlPlaneTenantId" | "resolveControlPlane">,
  tenantId: string,
): Promise<string | undefined> {
  if (!deps.resolveControlPlane) return deps.controlPlaneTenantId;
  return (await deps.resolveControlPlane({ tenant_id: tenantId }))?.tenantId;
}

/**
 * The hash a sync of `tenantId` would store right now. The hash depends on the
 * chain and its content, not on the tenant, so tenants that share a chain share
 * one computation (memoised for the life of the returned function).
 */
export function createExpectedHash(
  deps: Pick<
    RolloutDeps,
    "adapters" | "controlPlaneTenantId" | "resolveControlPlane" | "maxDepth"
  >,
): (tenantId: string) => Promise<string> {
  const memo = new Map<string, Promise<string>>();

  return async (tenantId) => {
    const legacyControlPlane = await resolveLegacyParent(deps, tenantId);
    const chain = await resolveTenantChain({
      tenantId,
      getTenant: (id) => deps.adapters.tenants.get(id),
      legacyControlPlane,
      maxDepth: deps.maxDepth,
    });
    const key = chain.join(">");

    let hash = memo.get(key);
    if (!hash) {
      hash = buildResolvedConfigBlock(deps.adapters, tenantId, {
        legacyControlPlane,
        maxDepth: deps.maxDepth,
      }).then((block) => block.hash);
      memo.set(key, hash);
    }
    return hash;
  };
}
