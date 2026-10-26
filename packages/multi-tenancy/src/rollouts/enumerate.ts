import { fetchAll, type DataAdapters, type Tenant } from "authhero";

export interface FleetTenant {
  tenantId: string;
  /** Levels below the root; 1 for a direct child. */
  depth: number;
  /** The content hash last applied to the tenant, if any. */
  appliedHash: string | null;
}

export interface EnumerateOptions {
  /**
   * The control plane a tenant without a `parent_tenant_id` inherits from, as
   * `resolveTenantChain` uses it (`undefined` when the tenant opts out).
   */
  resolveLegacyParent: (tenantId: string) => Promise<string | undefined>;
  /** Longest chain to follow before giving up on a tenant (cycle guard). */
  maxDepth?: number;
}

/**
 * The tenants below `rootId` that receive pushes (`config_sync: "synced"`),
 * ordered by depth and then id, so a parent is always rolled out before its
 * children. Parents are resolved like `resolveTenantChain`: `parent_tenant_id`,
 * else the legacy control plane. Reads every tenant once.
 */
export async function listSyncedDescendants(
  adapters: Pick<DataAdapters, "tenants">,
  rootId: string,
  options: EnumerateOptions,
): Promise<FleetTenant[]> {
  const maxDepth = options.maxDepth ?? 8;
  const tenants = await fetchAll<Tenant>(
    (params) => adapters.tenants.list(params),
    "tenants",
    { cursorField: "id", pageSize: 100 },
  );
  const byId = new Map(tenants.map((t) => [t.id, t]));

  const parentOf = async (tenant: Tenant) =>
    tenant.parent_tenant_id ??
    (tenant.id === rootId
      ? undefined
      : await options.resolveLegacyParent(tenant.id));

  const result: FleetTenant[] = [];
  for (const tenant of tenants) {
    if (tenant.id === rootId || tenant.config_sync !== "synced") continue;

    let depth = 0;
    let current: Tenant | undefined = tenant;
    let reachedRoot = false;
    while (current && depth <= maxDepth) {
      const parentId: string | undefined = await parentOf(current);
      if (!parentId) break;
      depth++;
      if (parentId === rootId) {
        reachedRoot = true;
        break;
      }
      current = byId.get(parentId);
    }
    if (reachedRoot) {
      result.push({
        tenantId: tenant.id,
        depth,
        appliedHash: tenant.config_sync_hash ?? null,
      });
    }
  }

  return result.sort(
    (a, b) => a.depth - b.depth || (a.tenantId < b.tenantId ? -1 : 1),
  );
}
