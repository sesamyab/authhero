import {
  createOperationRecorder,
  runSyncDefaultsStep,
  type StepConfig,
  type StepRunner,
  type SyncConfigFn,
  type TenantOperationStores,
} from "@authhero/multi-tenancy";
import type { TenantOperationWorkflowParams } from "./types";

export type SyncDefaultsStepName =
  | "mark-running"
  | "sync-defaults"
  | "mark-succeeded"
  | "mark-failed";

export interface SyncDefaultsOperationDeps {
  /** Control-plane operation log stores. */
  stores: TenantOperationStores;
  /**
   * How the tenant's resolved config reaches its database, for example
   * `createDispatchSyncConfig(...)`.
   */
  syncConfig: SyncConfigFn;
  /** Per-step overrides of the retry/timeout defaults. */
  stepConfig?: Partial<Record<SyncDefaultsStepName, StepConfig>>;
}

// A sync is idempotent (the hash makes a repeat a no-op), so retrying is safe;
// the budget is smaller than provisioning's because a refused payload (for
// example a key ring that cannot decrypt) does not get better with time.
const DEFAULT_STEP_CONFIG: StepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable `sync-defaults` operation: sync one tenant's resolved parent-chain
 * config into its database as a Workflows instance, writing to the control-plane
 * operation log at every step boundary (the same shape as
 * {@link runProvisionOperation}, and the same step logic as the inline
 * executor). The operation's `input` (`dry_run`, `force`) is read from its row,
 * so nothing but ids crosses the Workflows boundary.
 *
 * A dry run records its diff in the operation's `result` and writes nothing to
 * the tenant. Any failure runs `mark-failed` (event + failed row) and rethrows
 * so the instance ends `errored`; if even that dies, the reconciler copies the
 * engine's terminal state into the row.
 */
export async function runSyncDefaultsOperation(
  deps: SyncDefaultsOperationDeps,
  params: TenantOperationWorkflowParams,
  step: StepRunner,
): Promise<void> {
  const recorder = createOperationRecorder(deps.stores);
  const config = (name: SyncDefaultsStepName): StepConfig =>
    deps.stepConfig?.[name] ?? DEFAULT_STEP_CONFIG;

  const operationId = params.operation_id;

  try {
    await step.do("mark-running", config("mark-running"), async () => {
      await recorder.markRunning(operationId, "sync-defaults");
    });

    await step.do("sync-defaults", config("sync-defaults"), async () => {
      await recorder.setCurrentStep(operationId, "sync-defaults");
      const operation = await deps.stores.tenantOperations.get(operationId);
      if (!operation) {
        throw new Error(`Operation "${operationId}" not found`);
      }
      const detail = await runSyncDefaultsStep({
        operation,
        syncConfig: deps.syncConfig,
        recorder,
      });
      await recorder.appendEvent(operationId, {
        step: "sync-defaults",
        outcome: "succeeded",
        detail,
      });
    });

    await step.do("mark-succeeded", config("mark-succeeded"), async () => {
      await recorder.markSucceeded(operationId);
    });
  } catch (error) {
    await step.do("mark-failed", config("mark-failed"), async () => {
      await recorder.appendEvent(operationId, {
        step: "mark-failed",
        outcome: "failed",
        detail: { message: errorMessage(error) },
      });
      await recorder.markFailed(operationId, error);
    });
    throw error;
  }
}
