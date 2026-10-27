import type { DataAdapters } from "@authhero/adapter-interfaces";
import {
  buildResolvedConfigBlock,
  type ApplyResolvedBlockResult,
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
          body: JSON.stringify({ tenantId, resolved, dryRun, force, prune }),
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

    return (await response.json()) as ApplyResolvedBlockResult;
  };
}
