import {
  TenantMemberRequestRejected,
  executeTenantMemberRequest,
  type DataAdapters,
  type ExecuteTenantMemberRequestOptions,
  type TenantMemberRequest,
  type TenantMembersBackend,
  type TenantOperation,
} from "authhero";
import type { OperationRecorder } from "./recorder";
import { errorToMessage } from "./recorder";
import { enqueueTenantOperation } from "./enqueue";
import type { TenantOperationExecutor, TenantOperationStores } from "./types";

/**
 * The `tenant-members-request` tenant operation (issue #1550): carries out a
 * team change that a tenant registered as a request in its own database.
 *
 * The request lives on the tenant's side, so the operation reaches it through
 * a {@link TenantMemberRequestStore}: in-process for tenants that share the
 * control plane's database, a dispatch push for tenants with their own. The
 * operation's `input` is only `{ request_id }`: what was asked (addresses,
 * ids) stays on the request row, because anyone who can read operations can
 * read `input`.
 */

/** How the control plane reads and answers a tenant's requests. */
export interface TenantMemberRequestStore {
  get(tenantId: string, id: string): Promise<TenantMemberRequest | null>;
  /**
   * Writes the outcome, only while the request is still `pending`. Returns
   * false when it was already finished, which makes a re-run harmless.
   */
  report(
    tenantId: string,
    id: string,
    outcome: {
      status: "succeeded" | "failed";
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<boolean>;
  /** Requests still `pending` and created before `olderThan` (ISO 8601). */
  listPending(
    tenantId: string,
    options: { olderThan: string },
  ): Promise<TenantMemberRequest[]>;
}

/** For tenants whose database is the control plane's own. */
export function createInProcessMemberRequestStore(
  adapters: Pick<DataAdapters, "tenantMemberRequests">,
): TenantMemberRequestStore {
  const store = () => {
    if (!adapters.tenantMemberRequests) {
      throw new Error("The data adapter has no tenantMemberRequests adapter");
    }
    return adapters.tenantMemberRequests;
  };
  return {
    get: (tenantId, id) => store().get(tenantId, id),
    async report(tenantId, id, outcome) {
      return store().update(
        tenantId,
        id,
        {
          status: outcome.status,
          result: outcome.result ?? null,
          error: outcome.error ?? null,
          finished_at: new Date().toISOString(),
        },
        "pending",
      );
    },
    async listPending(tenantId, { olderThan }) {
      const result = await store().list(tenantId, {
        status: "pending",
        created_before: olderThan,
        per_page: 100,
      });
      return result.requests;
    },
  };
}

/** The request an operation is about, from its `input`. */
export function memberRequestIdOf(
  operation: Pick<TenantOperation, "input">,
): string | undefined {
  const id = (operation.input as Record<string, unknown> | null)?.request_id;
  return typeof id === "string" && id ? id : undefined;
}

// Reasons are shown to the tenant's admins; keep them short.
const MAX_REASON_LENGTH = 300;

export interface RunTenantMembersRequestParams {
  operation: Pick<TenantOperation, "id" | "tenant_id" | "input">;
  store: TenantMemberRequestStore;
  /** The control-plane team backend, built without a request in hand. */
  getBackend: () => TenantMembersBackend | Promise<TenantMembersBackend>;
  recorder: Pick<OperationRecorder, "setResult">;
  executeOptions?: ExecuteTenantMemberRequestOptions;
}

/**
 * The step both executors run. Reads the request, carries it out against the
 * tenant's team (which checks the tenant and the requester again), and writes
 * the outcome back to the request.
 *
 * - A request that cannot or must not run (the requester left the team, the
 *   payload is wrong) is a legitimate outcome: the request is reported
 *   `failed` with the reason and the operation `succeeded`, because the
 *   control plane did its job. Nothing retries it.
 * - Any other error (the database, the team backend, the write-back) fails the
 *   operation and leaves the request `pending`, so a later run or the
 *   reconcile sweep tries again. That is safe: the work is idempotent.
 */
export async function runTenantMembersRequestStep(
  params: RunTenantMembersRequestParams,
): Promise<Record<string, unknown>> {
  const { operation, store, getBackend, recorder } = params;
  const tenantId = operation.tenant_id;
  const requestId = memberRequestIdOf(operation);
  if (!tenantId || !requestId) {
    throw new Error(
      "tenant-members-request operations require a tenant_id and a request_id",
    );
  }

  const request = await store.get(tenantId, requestId);
  if (!request) {
    throw new Error(
      `Request ${requestId} was not found for tenant ${tenantId}`,
    );
  }
  if (request.status !== "pending") {
    const summary = {
      request_id: requestId,
      outcome: "already_finished",
      status: request.status,
    };
    await recorder.setResult(operation.id, summary);
    return summary;
  }

  let outcome: Parameters<TenantMemberRequestStore["report"]>[2];
  try {
    const result = await executeTenantMemberRequest(
      await getBackend(),
      tenantId,
      request,
      params.executeOptions,
    );
    outcome = { status: "succeeded", result };
  } catch (error) {
    if (!(error instanceof TenantMemberRequestRejected)) throw error;
    outcome = {
      status: "failed",
      error: errorToMessage(error).slice(0, MAX_REASON_LENGTH),
    };
  }

  const reported = await store.report(tenantId, requestId, outcome);
  const summary = {
    request_id: requestId,
    outcome: outcome.status,
    // False when someone finished the request first.
    reported,
    ...(outcome.status === "failed" ? { reason: outcome.error } : {}),
  };
  await recorder.setResult(operation.id, summary);
  return summary;
}

/** How many failed runs a request gets before the sweep gives up on it. */
export const MAX_MEMBER_REQUEST_ATTEMPTS = 5;

/**
 * Enqueues the operation for one request, once. A notification can arrive
 * twice and the sweep can race it, so an operation that is already pending,
 * running or succeeded for the request is returned instead of a new one.
 */
export async function enqueueTenantMemberRequest(
  deps: {
    stores: TenantOperationStores;
    executor: TenantOperationExecutor;
  },
  tenantId: string,
  requestId: string,
  options: { initiatedBy?: string } = {},
): Promise<TenantOperation> {
  const { operations } = await deps.stores.tenantOperations.list({
    tenant_id: tenantId,
    kind: "tenant-members-request",
    per_page: 100,
  });
  const existing = operations.find(
    (op) =>
      memberRequestIdOf(op) === requestId &&
      (op.status === "pending" ||
        op.status === "running" ||
        op.status === "succeeded"),
  );
  if (existing) return existing;

  return enqueueTenantOperation(
    deps.stores,
    deps.executor,
    {
      kind: "tenant-members-request",
      tenant_id: tenantId,
      initiated_by: options.initiatedBy,
      input: { request_id: requestId },
    },
    // The outcome is on the request; a failed run is returned, not thrown, so
    // the notification that started it is still answered.
    { returnFailed: true },
  );
}

export interface ReconcileTenantMemberRequestsDeps {
  stores: TenantOperationStores;
  executor: TenantOperationExecutor;
  store: TenantMemberRequestStore;
  /** The tenants to look at, for example the ones with their own database. */
  tenantIds: () => Promise<string[]> | string[];
  /** Requests younger than this are left to the notification. Default 5 minutes. */
  graceMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface ReconcileTenantMemberRequestsResult {
  checked: number;
  enqueued: number;
  gaveUp: number;
  /** Tenants whose requests could not be read, for example an unreachable shard. */
  unreachable: string[];
}

/**
 * Sweep for requests the control plane never ran: the notification was lost,
 * or the run failed. A tenant worker cannot run a cron, so this runs on the
 * control plane. It enqueues the operation for a `pending` request that has
 * none in flight, and after `maxAttempts` failed runs reports the request
 * `failed` so it does not stay pending forever.
 */
export async function reconcileTenantMemberRequests(
  deps: ReconcileTenantMemberRequestsDeps,
): Promise<ReconcileTenantMemberRequestsResult> {
  const now = deps.now?.() ?? new Date();
  const olderThan = new Date(
    now.getTime() - (deps.graceMs ?? 5 * 60_000),
  ).toISOString();
  const maxAttempts = deps.maxAttempts ?? MAX_MEMBER_REQUEST_ATTEMPTS;
  const result: ReconcileTenantMemberRequestsResult = {
    checked: 0,
    enqueued: 0,
    gaveUp: 0,
    unreachable: [],
  };

  for (const tenantId of await deps.tenantIds()) {
    let pending: TenantMemberRequest[];
    try {
      pending = await deps.store.listPending(tenantId, { olderThan });
    } catch (error) {
      console.warn(
        `[tenant-members] could not read the requests of ${tenantId}:`,
        error,
      );
      result.unreachable.push(tenantId);
      continue;
    }
    if (pending.length === 0) continue;

    const { operations } = await deps.stores.tenantOperations.list({
      tenant_id: tenantId,
      kind: "tenant-members-request",
      per_page: 100,
    });

    for (const request of pending) {
      result.checked += 1;
      const own = operations.filter(
        (op) => memberRequestIdOf(op) === request.id,
      );
      if (
        own.some((op) => op.status === "pending" || op.status === "running")
      ) {
        continue;
      }
      if (own.filter((op) => op.status === "failed").length >= maxAttempts) {
        try {
          const reported = await deps.store.report(tenantId, request.id, {
            status: "failed",
            error: "The control plane could not carry out this request",
          });
          // False: someone finished the request first, so there is nothing to give up on.
          if (reported) result.gaveUp += 1;
        } catch (error) {
          // The next sweep tries again; the others still need their turn.
          console.warn(
            `[tenant-members] could not report request ${request.id} as failed:`,
            error,
          );
        }
        continue;
      }
      try {
        await enqueueTenantMemberRequest(deps, tenantId, request.id);
        result.enqueued += 1;
      } catch (error) {
        console.warn(
          `[tenant-members] could not enqueue request ${request.id}:`,
          error,
        );
      }
    }
  }
  return result;
}
