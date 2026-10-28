import { isSyncedRowId } from "authhero";
import { resolveTenantChain } from "../inheritance/chain";
import { effectiveScope } from "../inheritance/merge";
import { readConfigRows } from "../inheritance/read";
import { keyOf, syncedRowId, type SyncEntity } from "../rollout/resolved-sync";
import { createExpectedHash, resolveLegacyParent } from "./hashes";
import type { RolloutDeps } from "./types";

export type ConfigSyncStatusDeps = Pick<
  RolloutDeps,
  "adapters" | "controlPlaneTenantId" | "resolveControlPlane" | "maxDepth"
>;

export interface ConfigSyncStatus {
  tenant_id: string;
  parent_tenant_id: string | null;
  config_sync: "inherit-on-read" | "synced" | "detached";
  config_sync_hash: string | null;
  config_synced_at: string | null;
  /** The hash a sync would store now; null for a tenant that is not synced. */
  expected_hash: string | null;
  /** A synced tenant whose stored hash differs from `expected_hash`. */
  drifted: boolean;
  /** Ancestors the config resolves from, nearest first. */
  chain: string[];
  /**
   * Which ancestor published each inherited row, keyed by the id the row has
   * in this tenant (`con_sy...`, singletons by `emailProvider`, `branding` and
   * `promptSettings`). Platform rows are left out: a child never sees them.
   */
  inherited: Record<string, string>;
}

/**
 * Sync status of one tenant, for the admin UI: the stored and expected hash,
 * whether they differ, and where its inherited rows come from. Content and
 * secrets never leave this function, only ids and tenant names.
 */
export async function getConfigSyncStatus(
  deps: ConfigSyncStatusDeps,
  tenantId: string,
): Promise<ConfigSyncStatus | null> {
  const tenant = await deps.adapters.tenants.get(tenantId);
  if (!tenant) return null;

  if (tenant.config_sync === "detached") {
    return {
      tenant_id: tenantId,
      parent_tenant_id: null,
      config_sync: "detached",
      config_sync_hash: null,
      config_synced_at: null,
      expected_hash: null,
      drifted: false,
      chain: [],
      inherited: {},
    };
  }

  const synced = tenant.config_sync === "synced";
  const legacyControlPlane = await resolveLegacyParent(deps, tenantId);
  const chain = await resolveTenantChain({
    tenantId,
    getTenant: (id) => deps.adapters.tenants.get(id),
    legacyControlPlane,
    maxDepth: deps.maxDepth,
  });

  const expectedHash = synced ? await createExpectedHash(deps)(tenantId) : null;
  const storedHash = tenant.config_sync_hash ?? null;

  const inherited: Record<string, string> = {};
  // Farthest ancestor first, so the nearest publisher wins.
  for (const ancestor of [...chain].reverse()) {
    const rows = await readConfigRows(deps.adapters, ancestor);
    const published = <T extends object>(
      entity: Parameters<typeof effectiveScope>[0],
      row: T,
    ) => effectiveScope(entity, row) === "shared";

    const add = async (entity: SyncEntity, list: object[], scoped: string) => {
      for (const row of list) {
        if (!published(scoped as never, row)) continue;
        const target = await syncedRowId(entity, tenantId, keyOf(entity, row));
        // A copy an ancestor itself received is credited to where it came from.
        // When the origin is not in the chain (a parent-less middle tenant that
        // got its rows from the control plane), the ancestor holding the copy
        // is the nearest publisher the tenant can see.
        const id =
          (row as { id?: string; hook_id?: string }).id ??
          (row as { hook_id?: string }).hook_id;
        if (id && isSyncedRowId(id) && inherited[target]) continue;
        inherited[target] = ancestor;
      }
    };
    await add("connection", rows.connections, "connection");
    await add("resourceServer", rows.resourceServers, "resourceServer");
    await add("action", rows.actions, "action");
    await add("hook", rows.hooks, "hook");
    if (rows.emailProvider && published("emailProvider", rows.emailProvider)) {
      inherited.emailProvider = ancestor;
    }
    if (rows.branding && published("branding", rows.branding)) {
      inherited.branding = ancestor;
    }
    if (
      rows.promptSettings &&
      published("promptSettings", rows.promptSettings)
    ) {
      inherited.promptSettings = ancestor;
    }
  }

  return {
    tenant_id: tenantId,
    parent_tenant_id: tenant.parent_tenant_id ?? null,
    config_sync: synced ? "synced" : "inherit-on-read",
    config_sync_hash: storedHash,
    config_synced_at: tenant.config_synced_at ?? null,
    expected_hash: expectedHash,
    drifted: synced && expectedHash !== storedHash,
    chain,
    inherited,
  };
}
