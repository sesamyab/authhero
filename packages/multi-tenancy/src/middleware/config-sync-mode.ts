import type { ResolvedControlPlane } from "./settings-inheritance";

/**
 * Per-tenant config sync mode (docs/design/tenant-config-inheritance.md,
 * section 5 step 3). A tenant in `synced` mode reads only its own database:
 * the resolver below answers `undefined` ("do not inherit") for it, which every
 * read-time inheritance path already understands.
 */

export interface ConfigSyncResolver {
  /** The control plane to inherit from, or `undefined` for opted-out and synced tenants. */
  resolve(params: { tenant_id: string }): Promise<ResolvedControlPlane>;
  /** Whether the tenant is in `synced` mode. Cached; never throws. */
  isSynced(tenantId: string): Promise<boolean>;
  /** Forget a tenant's cached mode (or all of them). */
  invalidate(tenantId?: string): void;
}

export interface ConfigSyncResolverOptions {
  /** The inheritance target for a tenant before the mode is considered. */
  base: (tenantId: string) => Promise<ResolvedControlPlane>;
  /** Reads the tenant row, from the raw (uncached) adapter. */
  getTenant: (
    tenantId: string,
  ) => Promise<{ config_sync?: string | null } | null>;
  /** The control plane tenant, which is never treated as synced. */
  controlPlaneTenantId?: string;
  /**
   * How long a tenant's mode is remembered, per isolate. A mode change reaches
   * other isolates within this time, so it is also how long to wait after a flip
   * before judging the result. @default 10000
   */
  ttlMs?: number;
  /** Upper bound on remembered tenants. @default 1000 */
  maxEntries?: number;
}

/** How long an isolate remembers a tenant's `config_sync` mode. */
export const DEFAULT_CONFIG_SYNC_TTL_MS = 10_000;

export function createConfigSyncResolver(
  options: ConfigSyncResolverOptions,
): ConfigSyncResolver {
  const { base, getTenant, controlPlaneTenantId } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIG_SYNC_TTL_MS;
  const maxEntries = options.maxEntries ?? 1000;
  const cache = new Map<string, { synced: boolean; expires: number }>();

  async function isSynced(tenantId: string): Promise<boolean> {
    if (tenantId === controlPlaneTenantId) return false;

    const hit = cache.get(tenantId);
    const now = Date.now();
    if (hit && hit.expires > now) return hit.synced;

    try {
      const tenant = await getTenant(tenantId);
      const synced = tenant?.config_sync === "synced";
      if (cache.size >= maxEntries) cache.clear();
      cache.set(tenantId, { synced, expires: now + ttlMs });
      return synced;
    } catch {
      // A failed lookup must never break a request: keep inheriting, and do
      // not remember the failure.
      return false;
    }
  }

  return {
    isSynced,
    invalidate(tenantId) {
      if (tenantId) cache.delete(tenantId);
      else cache.clear();
    },
    async resolve({ tenant_id }) {
      const resolved = await base(tenant_id);
      // Nothing to opt out of: the tenant already does not inherit, or it is
      // the control plane itself.
      if (!resolved || resolved.tenantId === tenant_id) return resolved;
      return (await isSynced(tenant_id)) ? undefined : resolved;
    },
  };
}
