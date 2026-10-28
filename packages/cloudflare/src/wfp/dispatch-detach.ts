import type { DataAdapters } from "@authhero/adapter-interfaces";
import {
  assertDetachEligible,
  emptyDetachResult,
  markTenantDetached,
  type DetachConfigFn,
  type DetachResult,
} from "@authhero/multi-tenancy";
import type { DispatchNamespace } from "../code-executor";
import {
  DEFAULT_SCRIPT_NAME_TEMPLATE,
  fillTemplate,
} from "./dispatch-sync-defaults";

const DETACH_PATH = "/internal/detach";

// A detach converts rows one by one, so it gets longer than a sync push.
const DEFAULT_DETACH_TIMEOUT_MS = 120_000;

export interface DispatchDetachOptions {
  /** The dispatch namespace binding the tenant workers live in. */
  dispatcher: DispatchNamespace;
  /** Script-name convention. Supports `{tenant_id}`. */
  scriptNameTemplate?: string;
  /**
   * Shared secret the tenant worker checks on `/internal/detach`
   * (`WFP_INTERNAL_SYNC_SECRET`). Sent as a bearer token.
   */
  internalSecret: string;
  /**
   * The control plane's adapters, where the tenant row that decides lives. Use
   * the raw layer.
   */
  controlPlaneAdapters: DataAdapters;
  /** Per-push timeout. Defaults to 120s. */
  timeoutMs?: number;
}

/**
 * Builds the `detach` operation's transport for tenants with their own worker
 * and database. The control plane checks that the tenant can be detached from
 * its own tenant row, asks the tenant worker to convert (or remove) the copies
 * in its database, and only when that went through marks its own tenant row
 * detached. A preview or a partial result leaves the row as it was, so a retry
 * can finish the job. Rejects when the push fails or the worker answers non-2xx,
 * which fails the operation.
 */
export function createDispatchDetach(
  options: DispatchDetachOptions,
): DetachConfigFn {
  const {
    dispatcher,
    scriptNameTemplate = DEFAULT_SCRIPT_NAME_TEMPLATE,
    internalSecret,
    controlPlaneAdapters,
    timeoutMs = DEFAULT_DETACH_TIMEOUT_MS,
  } = options;

  return async (tenantId, { dryRun, clean }) => {
    const tenant = await controlPlaneAdapters.tenants.get(tenantId);
    if (!tenant) throw new Error(`Tenant "${tenantId}" not found`);
    if (tenant.config_sync === "detached") {
      return emptyDetachResult("already-detached");
    }
    assertDetachEligible(tenantId, tenant);

    const scriptName = fillTemplate(scriptNameTemplate, tenantId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await dispatcher
        .get(scriptName)
        .fetch(`https://tenant.internal${DETACH_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${internalSecret}`,
          },
          body: JSON.stringify({ tenantId, dryRun, clean }),
          signal: controller.signal,
        });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const code = response.headers.get("x-authhero-error");
      throw new Error(
        `detach push to "${scriptName}" failed: ${response.status}` +
          `${code ? ` (${code})` : ""} ${body.slice(0, 256)}`,
      );
    }

    const result = (await response.json()) as DetachResult;
    if (!dryRun && result.status === "detached") {
      await markTenantDetached(controlPlaneAdapters, tenantId);
    }
    return result;
  };
}
