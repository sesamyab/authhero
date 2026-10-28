import {
  createOperationRecorder,
  runDetachStep,
  type StepConfig,
  type StepRunner,
  type DetachConfigFn,
  type TenantOperationStores,
} from "@authhero/multi-tenancy";
import type { TenantOperationWorkflowParams } from "./types";

export type DetachStepName =
  | "mark-running"
  | "detach"
  | "mark-succeeded"
  | "mark-failed";

export interface DetachOperationDeps {
  /** Control-plane operation log stores. */
  stores: TenantOperationStores;
  /**
   * How the detach reaches the tenant's database, for example
   * `createDispatchDetach(...)`.
   */
  detachTenant: DetachConfigFn;
  /**
   * Per-step overrides of the retry/timeout defaults. The `detach` step has no
   * automatic retries unless a host sets them.
   */
  stepConfig?: Partial<Record<DetachStepName, StepConfig>>;
}

// The bookkeeping steps are safe to retry. The detach step is not retried
// automatically: it is not atomic, so a retry after a partial run would create
// a second copy of every row the first run already converted. A failed detach
// is reported (the row is `failed`, with the per-row errors in its result) and
// an operator runs it again after reading what happened. The timeout is long:
// every row is converted one by one.
const DEFAULT_STEP_CONFIG: StepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};
const DETACH_STEP_CONFIG: StepConfig = {
  retries: { limit: 0, delay: "5 seconds" },
  timeout: "5 minutes",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable `detach` operation: a synced tenant leaves its parent, as a Workflows
 * instance that writes to the control-plane operation log at every step
 * boundary (the same shape as {@link runSyncDefaultsOperation}, and the same
 * step logic as the inline executor). The operation's `input` (`dry_run`,
 * `clean`) is read from its row, so nothing but ids crosses the Workflows
 * boundary.
 *
 * A dry run records what would change in the operation's `result` and writes
 * nothing. Any failure runs `mark-failed` (event + failed row) and rethrows
 * so the instance ends `errored`; if even that dies, the reconciler copies the
 * engine's terminal state into the row.
 */
export async function runDetachOperation(
  deps: DetachOperationDeps,
  params: TenantOperationWorkflowParams,
  step: StepRunner,
): Promise<void> {
  const recorder = createOperationRecorder(deps.stores);
  const config = (name: DetachStepName): StepConfig =>
    deps.stepConfig?.[name] ??
    (name === "detach" ? DETACH_STEP_CONFIG : DEFAULT_STEP_CONFIG);

  const operationId = params.operation_id;

  try {
    await step.do("mark-running", config("mark-running"), async () => {
      await recorder.markRunning(operationId, "detach");
    });

    await step.do("detach", config("detach"), async () => {
      await recorder.setCurrentStep(operationId, "detach");
      const operation = await deps.stores.tenantOperations.get(operationId);
      if (!operation) {
        throw new Error(`Operation "${operationId}" not found`);
      }
      const detail = await runDetachStep({
        operation,
        detachTenant: deps.detachTenant,
        recorder,
      });
      await recorder.appendEvent(operationId, {
        step: "detach",
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
