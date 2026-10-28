import { Context } from "hono";
import { Hook, LogTypes } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import { JSONHTTPException } from "../errors/json-http-exception";
import { getExecutorData } from "../helpers/request-data";
import { logMessage } from "../helpers/logging";
import {
  CodeHookEventInput,
  executeCodeHook,
  HandleCodeHookOutcome,
  isCodeHook,
  persistActionExecution,
} from "./codehooks";

/** Blocking policies run before signup validation or a write, and fail closed. */
export async function runBlockingActions(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
  triggerId:
    | "validate-registration-username"
    | "pre-user-update"
    | "pre-user-deletion",
  event: CodeHookEventInput,
): Promise<{ allowed: boolean; reason?: string }> {
  // This stack includes platform-scoped policies hidden from management reads.
  const data = getExecutorData(ctx);
  const hooks: Hook[] = [];
  for (let page = 0; ; page++) {
    const result = await data.hooks.list(tenantId, {
      page,
      per_page: 100,
      q: `trigger_id:${triggerId}`,
    });
    hooks.push(...result.hooks);
    if (result.hooks.length < 100) break;
  }
  const codeHooks = hooks
    .filter((h) => h.enabled && h.trigger_id === triggerId)
    .filter(isCodeHook)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const outcomes: HandleCodeHookOutcome[] = [];
  const defaultDenialReason =
    triggerId === "validate-registration-username"
      ? "Signup not allowed by Action"
      : "Operation denied by lifecycle Action";

  const persist = async () => {
    const id = await persistActionExecution(
      data,
      tenantId,
      triggerId,
      outcomes,
      {
        logCapture: ctx.env.actionExecutionLogs,
      },
    );
    if (id) ctx.set("action_execution_id", id);
  };

  for (const hook of codeHooks) {
    let denialReason: string | undefined;
    let outcome: HandleCodeHookOutcome;
    try {
      if (!ctx.env.codeExecutor) throw new Error("No code executor configured");
      outcome = await executeCodeHook({
        codeExecutor: ctx.env.codeExecutor,
        data,
        tenantId,
        hook,
        event,
        triggerId,
        api: {
          access: {
            // Record the denial without throwing so execution logs are retained.
            deny: (reason?: string) => {
              denialReason = typeof reason === "string" ? reason : undefined;
            },
          },
        },
      });
      if (outcome.denied) {
        outcome.result.error = {
          id: "access_denied",
          msg: denialReason || defaultDenialReason,
        };
      }
    } catch (error) {
      outcome = {
        result: {
          action_name: hook.code_id,
          error: {
            id: "execution_threw",
            msg: error instanceof Error ? error.message : String(error),
          },
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        },
        denied: false,
        logs: [],
      };
    }
    outcomes.push(outcome);
    if (outcome.denied || outcome.result.error) {
      await persist();
      await logMessage(ctx, tenantId, {
        type: LogTypes.FAILED_HOOK,
        description: `${triggerId} Action ${outcome.denied ? "denied the operation" : "failed"}`,
        userId: typeof event.user_id === "string" ? event.user_id : undefined,
      });
      return {
        allowed: false,
        reason: outcome.denied
          ? denialReason || defaultDenialReason
          : `${triggerId} Action failed`,
      };
    }
  }
  await persist();
  return { allowed: true };
}

/** Cancel lifecycle writes when a blocking Action denies or fails. */
export async function runPreUserActions(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
  triggerId: "pre-user-update" | "pre-user-deletion",
  event: CodeHookEventInput,
): Promise<void> {
  const result = await runBlockingActions(ctx, tenantId, triggerId, event);
  if (!result.allowed) {
    throw new JSONHTTPException(400, { message: result.reason });
  }
}
