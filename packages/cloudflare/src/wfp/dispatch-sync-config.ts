import type { DataAdapters } from "@authhero/adapter-interfaces";
import {
  buildControlPlaneSigningKeys,
  buildResolvedConfigBlock,
  type ApplyResolvedBlockResult,
  syncErrors,
  type SyncConfigFn,
} from "@authhero/multi-tenancy";
import type { DispatchNamespace } from "../code-executor";
import {
  DEFAULT_SCRIPT_NAME_TEMPLATE,
  DEFAULT_TIMEOUT_MS,
  fillTemplate,
} from "./dispatch-sync-defaults";

const SYNC_CONFIG_PATH = "/internal/sync-config";

export interface DispatchSyncConfigOptions {
  /** The dispatch namespace binding the tenant workers live in. */
  dispatcher: DispatchNamespace;
  /** Script-name convention. Supports `{tenant_id}`. */
  scriptNameTemplate?: string;
  /**
   * Shared secret the tenant worker checks on `/internal/sync-config`
   * (`WFP_INTERNAL_SYNC_SECRET`). Sent as a bearer token.
   */
  internalSecret: string;
  /**
   * The control plane, used as implicit parent for tenants without a
   * `parent_tenant_id`.
   */
  controlPlaneTenantId: string;
  /**
   * Adapters for reading the chain. Use the layer that returns secrets as
   * stored (ciphertext): they are copied without being decrypted.
   */
  controlPlaneAdapters: DataAdapters;
  /** Maximum ancestors, see `resolveTenantChain`. */
  maxDepth?: number;
  /** Per-push timeout. Defaults to 30s. */
  timeoutMs?: number;
}

/**
 * Builds the `sync-defaults` operation's transport for tenants with their own
 * worker and database: resolve the tenant's chain on the control plane, push
 * the resolved block to the tenant worker's `/internal/sync-config`, and return
 * what it applied (or, for a dry run, what it would). The tenant worker never
 * calls back to the control plane. Rejects when the push fails or the worker
 * answers non-2xx, which fails the operation.
 */
export function createDispatchSyncConfig(
  options: DispatchSyncConfigOptions,
): SyncConfigFn {
  const {
    dispatcher,
    scriptNameTemplate = DEFAULT_SCRIPT_NAME_TEMPLATE,
    internalSecret,
    controlPlaneTenantId,
    controlPlaneAdapters,
    maxDepth,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  return async (tenantId, { dryRun, force, prune }) => {
    const tenant = await controlPlaneAdapters.tenants.get(tenantId);
    if (tenant?.config_sync === "detached") {
      throw new Error(
        `Tenant "${tenantId}" is detached from its parent: set config_sync back to "inherit-on-read" or "synced" before syncing it`,
      );
    }
    const resolved = await buildResolvedConfigBlock(
      controlPlaneAdapters,
      tenantId,
      { legacyControlPlane: controlPlaneTenantId, maxDepth },
    );

    // The control plane's public signing keys travel with every push. They are
    // outside the block (and its hash), so a tenant that lacks one, or has not
    // seen a rotation yet, is brought up to date without showing as drifted.
    const signingKeys =
      await buildControlPlaneSigningKeys(controlPlaneAdapters);

    const scriptName = fillTemplate(scriptNameTemplate, tenantId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await dispatcher
        .get(scriptName)
        .fetch(`https://tenant.internal${SYNC_CONFIG_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${internalSecret}`,
          },
          body: JSON.stringify({
            tenantId,
            resolved,
            signingKeys,
            dryRun,
            force,
            prune,
          }),
          signal: controller.signal,
        });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const code = response.headers.get("x-authhero-error");
      throw new Error(
        `sync-config push to "${scriptName}" failed: ${response.status}` +
          `${code ? ` (${code})` : ""} ${body.slice(0, 256)}`,
      );
    }

    const result = (await response.json()) as ApplyResolvedBlockResult;

    // The tenant worker records the applied hash in its own database only.
    // Status and the drift reconcile read the control plane's row, so mirror it
    // there. Only for a real, clean run: a dry run applied nothing, and a
    // partial run did not reach the block's hash. "up-to-date" means the tenant
    // already holds this hash, which the control plane may not know yet.
    //
    // A control plane key the tenant could not store counts as a failure too:
    // it is reported next to the block, outside the entity results that
    // `syncErrors` reads, and recording the hash would show the tenant as up to
    // date while control-plane tokens still fail with "No matching kid found".
    const keyErrors =
      (result as { signingKeys?: { errors?: unknown[] } }).signingKeys
        ?.errors ?? [];
    if (keyErrors.length > 0) {
      console.error(
        `[wfp] "${tenantId}" could not store ${keyErrors.length} control plane signing key(s); the config hash is not recorded, so it shows as drifted:`,
        keyErrors,
      );
    }
    if (
      !dryRun &&
      result.status !== "dry-run" &&
      result.hash &&
      tenant &&
      syncErrors(result).length === 0 &&
      keyErrors.length === 0
    ) {
      // Two syncs of one tenant can overlap (an operator and a rollout), and a
      // parent can be edited while a push is in flight. Either way this push
      // may carry a hash the chain has moved on from, and writing it would put
      // an older result over a newer one. So only record it while it is still
      // what the chain resolves to. Otherwise leave the row as it is: the
      // tenant then shows as drifted and the next sync records the current
      // hash, which is the safe direction to be wrong in.
      //
      // The push has already been applied, so a failure here must not fail the
      // operation: it would report a sync that did happen as failed. Leave the
      // row stale instead (the tenant shows as drifted and the next sync
      // records it) and return what the tenant reported.
      try {
        const current = await buildResolvedConfigBlock(
          controlPlaneAdapters,
          tenantId,
          { legacyControlPlane: controlPlaneTenantId, maxDepth },
        );
        if (current.hash === result.hash) {
          await controlPlaneAdapters.tenants.update(tenantId, {
            config_sync_hash: result.hash,
            config_synced_at: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error(
          `[wfp] could not record the applied config hash of "${tenantId}" on the control plane; it will show as drifted until the next sync:`,
          error,
        );
      }
    }

    return result;
  };
}
