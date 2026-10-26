import type { DataAdapters } from "authhero";
import type { ControlPlaneResolver } from "../middleware";
import type { TenantOperationExecutor } from "../operations";

/** Everything the rollout functions need, wired once by the host. */
export interface RolloutDeps {
  /**
   * Control-plane adapters: tenants, tenant operations and events, rollouts and
   * logs. Must be the layer that returns secrets as stored (ciphertext).
   */
  adapters: DataAdapters;
  /**
   * Starts the per-tenant `sync-defaults` operations: the inline executor, or
   * the Cloudflare Workflows executor.
   */
  executor: TenantOperationExecutor;
  /** The control plane, parent of tenants that have no `parent_tenant_id`. */
  controlPlaneTenantId: string;
  /** Per-tenant override of the implicit parent, as for `initMultiTenant`. */
  resolveControlPlane?: ControlPlaneResolver;
  /** Longest parent chain, see `resolveTenantChain`. */
  maxDepth?: number;
  /** Clock override for tests. */
  now?: () => number;
}
