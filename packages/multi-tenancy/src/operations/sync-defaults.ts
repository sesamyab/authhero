import type { DataAdapters, TenantOperation } from "authhero";
import {
  ApplyResolvedBlockResult,
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
} from "../rollout/resolved-sync";
import type { ControlPlaneResolver } from "../middleware";
import type { OperationRecorder } from "./recorder";

/**
 * The `sync-defaults` tenant operation (docs/design/tenant-config-inheritance.md
 * sections 4.1 and 5 step 4): sync one tenant's resolved parent-chain config
 * into its own database, as a tracked operation with history.
 *
 * Execution is split from transport. The steps below are shared by the inline
 * and the Cloudflare Workflows executor; how the block reaches the tenant's
 * database (in-process, or pushed to a tenant worker) is a `SyncConfigFn`.
 */

export interface SyncConfigOptions {
  /** Compute and report the diff; write nothing. */
  dryRun: boolean;
  /** Apply even when the tenant's stored hash equals the block's. */
  force: boolean;
  /** Remove synced copies the parent no longer shares. */
  prune?: boolean;
}

/** Syncs one tenant and returns what happened (or, for a dry run, what would). */
export type SyncConfigFn = (
  tenantId: string,
  options: SyncConfigOptions,
) => Promise<ApplyResolvedBlockResult>;

/** Reads the operation's `input` (fixed at creation, never secrets). */
export function syncOptionsOf(
  operation: Pick<TenantOperation, "input">,
): SyncConfigOptions {
  const input = (operation.input ?? {}) as Record<string, unknown>;
  return {
    dryRun: input.dry_run === true,
    force: input.force === true,
    prune: input.prune === true,
  };
}

/** Every per-entity error message the sync reported. */
export function syncErrors(result: ApplyResolvedBlockResult): string[] {
  return Object.values(result.entities).flatMap((outcome) => outcome.errors);
}

// Per-row error messages kept on the operation: capped, because they come from
// the database and zod and can be long.
const MAX_ERROR_MESSAGES = 20;
const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * The JSON-serialisable outcome stored in the operation's `result`: the status,
 * hash, per-entity counts, the changed `entity:key` list, the same changes as
 * structured `rows`, and a capped list of the error messages. Never row content
 * or secrets.
 */
export function summarizeSyncResult(
  result: ApplyResolvedBlockResult,
  options: SyncConfigOptions,
): Record<string, unknown> {
  return {
    dry_run: options.dryRun,
    prune: options.prune,
    status: result.status,
    hash: result.hash,
    changes: result.changes,
    rows: result.rows ?? [],
    error_messages: syncErrors(result)
      .slice(0, MAX_ERROR_MESSAGES)
      .map((message) => message.slice(0, MAX_ERROR_MESSAGE_LENGTH)),
    entities: Object.fromEntries(
      Object.entries(result.entities).map(([entity, o]) => [
        entity,
        {
          added: o.added,
          changed: o.changed,
          unchanged: o.unchanged,
          deleted: o.deleted,
          errors: o.errors.length,
        },
      ]),
    ),
  };
}

/**
 * The step both executors run: sync, record the outcome on the operation row,
 * and fail the step when any row reported an error. The result is written
 * before the failure is raised so a failed run still shows what it did.
 */
export async function runSyncDefaultsStep(params: {
  operation: Pick<TenantOperation, "id" | "tenant_id" | "input">;
  syncConfig: SyncConfigFn;
  recorder: Pick<OperationRecorder, "setResult">;
}): Promise<Record<string, unknown>> {
  const { operation, syncConfig, recorder } = params;
  if (!operation.tenant_id) {
    throw new Error("sync-defaults operations require a tenant_id");
  }

  const options = syncOptionsOf(operation);
  const result = await syncConfig(operation.tenant_id, options);
  const summary = summarizeSyncResult(result, options);
  await recorder.setResult(operation.id, summary);

  const errors = syncErrors(result);
  if (errors.length > 0) {
    const shown = errors.slice(0, 3).join("; ");
    throw new Error(
      `sync-defaults reported ${errors.length} error(s): ${shown}${
        errors.length > 3 ? "; ..." : ""
      }`,
    );
  }
  return summary;
}

/**
 * Sync for tenants whose database is the control plane's own (shared
 * deployments). Reads the chain from, and applies the block to, `adapters`,
 * which should be the layer that returns secrets as stored (ciphertext) so they
 * are copied without being decrypted. A tenant with its own worker and database
 * (`deployment_type: "wfp"`) is not reachable this way: use a dispatch
 * transport.
 */
export function createInProcessSyncConfig(
  adapters: DataAdapters,
  config: {
    controlPlaneTenantId: string;
    resolveControlPlane?: ControlPlaneResolver;
    maxDepth?: number;
  },
): SyncConfigFn {
  return async (tenantId, options) => {
    const tenant = await adapters.tenants.get(tenantId);
    if (!tenant) throw new Error(`Tenant "${tenantId}" not found`);
    if (tenant.config_sync === "detached") {
      throw new Error(
        `Tenant "${tenantId}" is detached from its parent: set config_sync back to "inherit-on-read" or "synced" before syncing it`,
      );
    }
    if (tenant.deployment_type === "wfp") {
      throw new Error(
        `Tenant "${tenantId}" has its own database: configure a dispatch sync (syncDefaults) for it`,
      );
    }

    // Tenants without a parent use the control plane as implicit parent.
    const resolved = config.resolveControlPlane
      ? await config.resolveControlPlane({ tenant_id: tenantId })
      : { tenantId: config.controlPlaneTenantId };

    const block = await buildResolvedConfigBlock(adapters, tenantId, {
      legacyControlPlane: resolved?.tenantId,
      maxDepth: config.maxDepth,
    });
    return applyResolvedConfigBlock(block, adapters, tenantId, {
      dryRun: options.dryRun,
      force: options.force,
      prune: options.prune,
    });
  };
}
