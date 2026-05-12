import { Context } from "hono";
import {
  ActionExecutionResult,
  ActionExecutionStatus,
  CodeExecutionLog,
  DataAdapters,
  Hook,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import { HookEvent, OnExecuteCredentialsExchangeAPI } from "../types/Hooks";

/**
 * Auth0 uses `post-login` for what we internally call `post-user-login`.
 * Normalize when writing execution records so the public API matches Auth0.
 */
export function toAuth0TriggerId(internal: string): string {
  if (internal === "post-user-login") return "post-login";
  return internal;
}

// Type guard for code hooks
type CodeHook = Extract<Hook, { code_id: string }>;

export function isCodeHook(hook: Hook): hook is CodeHook {
  return "code_id" in hook;
}

/**
 * Build a serializable event object from a HookEvent.
 * Strips the `ctx` property (Hono context) which cannot be serialized,
 * and returns a plain JSON-compatible object.
 */
export function buildSerializableEvent(
  event: HookEvent,
  secrets?: Record<string, string>,
): Record<string, unknown> {
  const { ctx, client, ...rest } = event;

  return {
    ...rest,
    client: client
      ? {
          client_id: client.client_id,
          name: client.name,
          metadata: client.client_metadata,
        }
      : undefined,
    secrets: secrets || {},
  };
}

/**
 * Replay recorded API calls from code hook execution against real API objects.
 * Handles calls like "accessToken.setCustomClaim" by navigating the api object.
 */
export function replayApiCalls(
  apiCalls: Array<{ method: string; args: unknown[] }>,
  api: Record<string, any>,
): void {
  for (const call of apiCalls) {
    const parts = call.method.split(".");
    if (parts.length !== 2) continue;

    const namespace = parts[0]!;
    const method = parts[1]!;
    if (api[namespace] && typeof api[namespace][method] === "function") {
      api[namespace][method](...call.args);
    }
  }
}

type ResolvedCode = {
  code: string;
  name: string;
  secrets?: Record<string, string>;
};

async function loadCodeForHook(
  data: DataAdapters,
  tenant_id: string,
  code_id: string,
): Promise<ResolvedCode | null> {
  const action = await data.actions.get(tenant_id, code_id);
  if (action) {
    const secrets = action.secrets?.reduce<Record<string, string>>(
      (acc, secret) => {
        if (secret.value !== undefined) acc[secret.name] = secret.value;
        return acc;
      },
      {},
    );
    return { code: action.code, name: action.name, secrets };
  }

  const hookCode = await data.hookCode.get(tenant_id, code_id);
  if (hookCode) {
    // Legacy hookCode entries have no display name — fall back to the id.
    return { code: hookCode.code, name: code_id, secrets: hookCode.secrets };
  }

  return null;
}

export type HandleCodeHookOutcome = {
  result: ActionExecutionResult;
  logs: CodeExecutionLog[];
  /** True if api.access.deny was recorded by the executor. */
  denied: boolean;
};

/**
 * Execute a code hook by fetching the code from the database, running it
 * through the code executor, and replaying API calls against the real api
 * object.
 *
 * Returns the per-action result (Auth0 shape) so the caller can aggregate
 * results across all actions on a trigger into a single `action_executions`
 * record. Returns `null` when the code cannot be located or the executor is
 * unavailable — the caller decides whether to surface that.
 */
export async function handleCodeHook(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  data: DataAdapters,
  hook: { code_id: string; hook_id: string },
  event: HookEvent,
  triggerId: string,
  api: Record<string, any>,
): Promise<HandleCodeHookOutcome | null> {
  const codeExecutor = ctx.env.codeExecutor;
  if (!codeExecutor) {
    return null;
  }

  const tenant_id = ctx.var.tenant_id || ctx.req.header("tenant-id");
  if (!tenant_id) {
    return null;
  }

  const codeRecord = await loadCodeForHook(data, tenant_id, hook.code_id);
  const started_at = new Date().toISOString();

  if (!codeRecord) {
    return {
      result: {
        action_name: hook.code_id,
        error: {
          id: "code_not_found",
          msg: `code_id ${hook.code_id} not found`,
        },
        started_at,
        ended_at: new Date().toISOString(),
      },
      logs: [],
      denied: false,
    };
  }

  const serializableEvent = buildSerializableEvent(event, codeRecord.secrets);

  const execResult = await codeExecutor.execute({
    code: codeRecord.code,
    hookCodeId: hook.code_id,
    triggerId,
    event: serializableEvent,
    timeoutMs: 5000,
  });

  const ended_at = new Date().toISOString();

  if (!execResult.success) {
    return {
      result: {
        action_name: codeRecord.name,
        error: {
          id: "execution_failed",
          msg: execResult.error || "Unknown error",
        },
        started_at,
        ended_at,
      },
      logs: execResult.logs ?? [],
      denied: false,
    };
  }

  // Replay the recorded API calls against the real api objects. This is where
  // api.access.deny fires (throws), where setCustomClaim mutates the real
  // token, etc.
  replayApiCalls(execResult.apiCalls, api);

  const denied = execResult.apiCalls.some((c) => c.method === "access.deny");

  return {
    result: {
      action_name: codeRecord.name,
      error: null,
      started_at,
      ended_at,
    },
    logs: execResult.logs ?? [],
    denied,
  };
}

/**
 * Aggregate per-action outcomes into an Auth0-shape execution record and
 * persist it via the adapter. Returns the generated execution_id (uuid)
 * so the caller can embed it in the surrounding tenant log.
 */
export async function persistActionExecution(
  data: DataAdapters,
  tenant_id: string,
  triggerId: string,
  outcomes: HandleCodeHookOutcome[],
): Promise<string | null> {
  if (outcomes.length === 0) return null;

  const id = crypto.randomUUID();
  const status: ActionExecutionStatus = outcomes.some((o) => o.denied)
    ? "canceled"
    : outcomes.some((o) => o.result.error)
      ? "partial"
      : "final";

  const logs = outcomes
    .filter((o) => o.logs.length > 0)
    .map((o) => ({ action_name: o.result.action_name, lines: o.logs }));

  await data.actionExecutions.create(tenant_id, {
    id,
    trigger_id: toAuth0TriggerId(triggerId),
    status,
    results: outcomes.map((o) => o.result),
    logs: logs.length > 0 ? logs : undefined,
  });

  return id;
}

/**
 * Execute code hooks for the credentials-exchange trigger.
 * Filters enabled code hooks from the provided hooks list and executes them.
 *
 * Returns the persisted `execution_id` so the caller can embed it in the
 * surrounding tenant log (the standard token-exchange log entry). The
 * execution record itself follows Auth0's shape — see
 * GET /api/v2/actions/executions/:id.
 */
export async function handleCredentialsExchangeCodeHooks(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  hooks: any[],
  event: HookEvent,
  api: OnExecuteCredentialsExchangeAPI,
): Promise<string | null> {
  const tenant_id = ctx.var.tenant_id || ctx.req.header("tenant-id");
  if (!tenant_id) return null;

  const codeHooks = hooks.filter((h: any) => h.enabled && isCodeHook(h));
  const outcomes: HandleCodeHookOutcome[] = [];

  for (const hook of codeHooks) {
    if (!isCodeHook(hook)) continue;
    try {
      const outcome = await handleCodeHook(
        ctx,
        ctx.env.data,
        hook,
        event,
        "credentials-exchange",
        api as unknown as Record<string, any>,
      );
      if (outcome) outcomes.push(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({
        result: {
          action_name: hook.code_id,
          error: { id: "execution_threw", msg: message },
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
        logs: [],
        denied: false,
      });
    }
  }

  return persistActionExecution(
    ctx.env.data,
    tenant_id,
    "credentials-exchange",
    outcomes,
  );
}
