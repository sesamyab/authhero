import { HTTPException } from "hono/http-exception";
import { DEFAULT_MAX_TENANT_DEPTH } from "../utils/tenant-tree";

/**
 * Resolves a tenant's ancestors, nearest first.
 *
 * A tenant with `parent_tenant_id` follows that chain. A tenant without one
 * falls back to the legacy control plane as an implicit single parent, so the
 * result matches what read-time inheritance does today. `legacyControlPlane`
 * is `undefined` when the tenant opts out of inheritance.
 */
export async function resolveTenantChain(params: {
  tenantId: string;
  getTenant: (
    id: string,
  ) => Promise<{ id: string; parent_tenant_id?: string | null } | null>;
  legacyControlPlane?: string;
  maxDepth?: number;
}): Promise<string[]> {
  const { tenantId, getTenant, legacyControlPlane } = params;
  const maxDepth = params.maxDepth ?? DEFAULT_MAX_TENANT_DEPTH;

  const self = await getTenant(tenantId);
  if (!self?.parent_tenant_id) {
    return legacyControlPlane && legacyControlPlane !== tenantId
      ? [legacyControlPlane]
      : [];
  }

  const chain: string[] = [];
  const seen = new Set<string>([tenantId]);
  let currentId: string | null | undefined = self.parent_tenant_id;
  while (currentId) {
    if (seen.has(currentId)) {
      throw new HTTPException(400, {
        message: `Tenant chain for '${tenantId}' contains a cycle at '${currentId}'`,
      });
    }
    seen.add(currentId);
    if (chain.length >= maxDepth) {
      throw new HTTPException(400, {
        message: `Tenant chain for '${tenantId}' is deeper than ${maxDepth}`,
      });
    }
    const current = await getTenant(currentId);
    if (!current) break;
    chain.push(currentId);
    currentId = current.parent_tenant_id;
  }
  return chain;
}
