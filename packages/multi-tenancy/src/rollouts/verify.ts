import { compareShadow } from "../inheritance/shadow";
import type { SyncConfigFn } from "../operations/sync-defaults";
import { resolveLegacyParent } from "./hashes";
import type { ConfigSyncStatusDeps } from "./status";

export interface ConfigSyncDifference {
  entity: string;
  key: string;
  /**
   * `missing`: the tenant lacks a row it should have. `extra`: it has a row it
   * should not. `changed`: the row differs, `fields` names the fields. `stale`:
   * a synced copy the parents no longer publish.
   */
  kind: "missing" | "extra" | "changed" | "stale";
  fields?: string[];
}

export interface ConfigSyncVerification {
  tenant_id: string;
  config_sync: "inherit-on-read" | "synced" | "detached";
  /**
   * How it was checked. `read-time`: what read-time inheritance gives against
   * what the parent chain resolves to. `sync-dry-run`: the tenant's own rows
   * against what a sync would write, which is how a synced tenant, including
   * one with its own database, is checked. `not-applicable`: a detached tenant
   * has no parent to compare with.
   */
  method: "read-time" | "sync-dry-run" | "not-applicable";
  /** True when there is no difference and no error: the hard pass criterion. */
  ok: boolean;
  /** Ids and field names only, never content or secrets. */
  differences: ConfigSyncDifference[];
  errors: string[];
}

export interface VerifyConfigSyncDeps extends ConfigSyncStatusDeps {
  /**
   * Runs a sync as a dry run, which is the read-only check of a synced tenant.
   * A tenant with its own database needs the dispatch transport, as for
   * `sync-defaults`.
   */
  syncConfig: SyncConfigFn;
}

const SYNC_ACTION_KIND = {
  added: "missing",
  changed: "changed",
  delete: "stale",
} as const;

/** The differences of a sync dry run, from `rows` or, for a sender without them, `changes`. */
function differencesOfSync(result: {
  rows?: Array<{ entity: string; key: string; action: string }>;
  changes: string[];
}): ConfigSyncDifference[] {
  const rows =
    result.rows ??
    result.changes.flatMap((change) => {
      if (change.startsWith("skip ")) return [];
      const remove = /^delete ([^:\s]+):(.*)$/.exec(change);
      if (remove) {
        return [{ entity: remove[1]!, key: remove[2]!, action: "delete" }];
      }
      const other = /^([^:\s]+):(.*)$/.exec(change);
      return other
        ? [{ entity: other[1]!, key: other[2]!, action: "changed" }]
        : [];
    });
  return rows.flatMap((row) => {
    const kind = SYNC_ACTION_KIND[row.action as keyof typeof SYNC_ACTION_KIND];
    // `skipped`: the tenant's own row wins, which is not a difference.
    return kind ? [{ entity: row.entity, key: row.key, kind }] : [];
  });
}

/**
 * Compares one tenant's config with what its parents publish, on demand and
 * read-only (no write, no log). The pass criterion is `ok`: an empty
 * `differences` and no `errors`. Returns null for an unknown tenant.
 *
 * A tenant that inherits on read is compared the way shadow mode does, without
 * the rows only the sync model copies (`expected`). A synced tenant is checked
 * with a sync dry run, which sees the tenant's own rows: a copy someone deleted
 * or edited shows up here although the stored hash still matches.
 */
export async function verifyTenantConfig(
  deps: VerifyConfigSyncDeps,
  tenantId: string,
): Promise<ConfigSyncVerification | null> {
  const tenant = await deps.adapters.tenants.get(tenantId);
  if (!tenant) return null;

  const mode = tenant.config_sync ?? "inherit-on-read";
  const base = {
    tenant_id: tenantId,
    config_sync: mode,
    errors: [] as string[],
  };

  if (mode === "detached") {
    return { ...base, method: "not-applicable", ok: true, differences: [] };
  }

  if (mode === "inherit-on-read") {
    const diffs = await compareShadow({
      adapters: deps.adapters,
      tenantId,
      legacyControlPlane: await resolveLegacyParent(deps, tenantId),
      maxDepth: deps.maxDepth,
    });
    const differences = diffs
      .filter((d) => !d.expected)
      .map(
        (d): ConfigSyncDifference => ({
          entity: d.entity,
          key: d.key,
          kind: d.kind,
          ...(d.fields.length > 0 ? { fields: d.fields } : {}),
        }),
      );
    return {
      ...base,
      method: "read-time",
      ok: differences.length === 0,
      differences,
    };
  }

  const result = await deps.syncConfig(tenantId, {
    dryRun: true,
    force: false,
    prune: false,
  });
  const differences = differencesOfSync(result);
  const errors = Object.entries(result.entities).flatMap(([entity, outcome]) =>
    outcome.errors.map((message) => `${entity} ${message}`.slice(0, 300)),
  );
  return {
    ...base,
    method: "sync-dry-run",
    ok: differences.length === 0 && errors.length === 0,
    differences,
    errors: errors.slice(0, 20),
  };
}
