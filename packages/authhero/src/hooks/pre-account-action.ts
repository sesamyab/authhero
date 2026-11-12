import { Context } from "hono";
import { LogTypes, User } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import {
  AccountActionOperation,
  HookRequest,
  PreAccountActionEvent,
} from "../types/Hooks";
import { EnrichedClient } from "../helpers/client";
import { getExecutorData } from "../helpers/request-data";
import { logMessage } from "../helpers/logging";
import { createTokenAPI } from "./helpers/token-api";
import { stripInternalUserFields } from "../helpers/hook-user-payload";
import {
  executeCodeHook,
  HandleCodeHookOutcome,
  persistActionExecution,
} from "./codehooks";
import { listEnabledCodeHooks } from "./lifecycle-codehooks";
import { RedirectException } from "../errors/redirect-exception";

export const PRE_ACCOUNT_ACTION_TRIGGER = "pre-account-action";

/** Shown when an action denies without a reason, or fails. */
export const DEFAULT_ACCOUNT_ACTION_DENIAL =
  "This action isn't available for your account.";

export type PreAccountActionDecision =
  | { type: "continue" }
  | { type: "redirect"; url: string }
  | { type: "deny"; reason: string };

/**
 * Thrown by the universal-login account screens when a `pre-account-action`
 * Action denies the operation. The universal-login error handler renders
 * `reason` on the branded error page (other error messages are replaced by a
 * generic text there, which would hide the tenant's explanation).
 */
export class AccountActionDeniedError extends Error {
  readonly status = 403;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "AccountActionDeniedError";
  }
}

/**
 * Resolve a redirect target from an Action. Relative URLs resolve against the
 * current request; anything other than http(s) is rejected so an Action can't
 * send the browser to `javascript:` or `data:` URLs. Unlike post-login
 * redirects, no `state` is appended: the user is leaving for a third party
 * and isn't expected to resume this transaction.
 */
function buildRedirectUrl(
  requestUrl: string,
  url: unknown,
  options: unknown,
): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("redirect.sendUserTo requires a URL");
  }
  const target = new URL(url, requestUrl);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(
      `redirect.sendUserTo: unsupported protocol ${target.protocol}`,
    );
  }
  if (options && typeof options === "object") {
    const query = Reflect.get(options, "query");
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === "string") target.searchParams.set(key, value);
      }
    }
  }
  return target.toString();
}

function resolveConnection(
  user: User | undefined,
  client: EnrichedClient | undefined,
): PreAccountActionEvent["connection"] {
  if (!user?.connection) return undefined;
  const connection = client?.connections?.find(
    (c) => c.name === user.connection,
  );
  return connection
    ? {
        id: connection.id,
        name: connection.name,
        strategy: connection.strategy,
      }
    : { name: user.connection, strategy: user.provider };
}

/**
 * Run the `pre-account-action` trigger: the `onExecutePreAccountAction` config
 * hook first, then the code Actions bound to the trigger in priority order.
 * The first one that redirects or denies decides the outcome and later ones
 * don't run. An Action that throws or fails denies the operation (fail
 * closed), like the other blocking triggers.
 */
export async function runPreAccountAction(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  params: {
    tenantId: string;
    operation: AccountActionOperation;
    /**
     * The user, or a loader for it. A loader only runs when something is bound
     * to the trigger, so screens don't pay for the lookup otherwise.
     */
    user?: User | (() => Promise<User | undefined>);
    client?: EnrichedClient;
    details?: Record<string, string>;
  },
): Promise<PreAccountActionDecision> {
  const { tenantId, operation, client, details } = params;
  const configHook = ctx.env.hooks?.onExecutePreAccountAction;
  const codeHooks = await listEnabledCodeHooks(
    ctx,
    tenantId,
    PRE_ACCOUNT_ACTION_TRIGGER,
  );
  if (!configHook && codeHooks.length === 0) {
    return { type: "continue" };
  }

  const user =
    typeof params.user === "function" ? await params.user() : params.user;
  const request: HookRequest = {
    method: ctx.req.method,
    ip: ctx.var.ip || "",
    user_agent: ctx.var.useragent || "",
    url: ctx.req.url,
  };
  const connection = resolveConnection(user, client);
  const outcomes: HandleCodeHookOutcome[] = [];
  let decision: PreAccountActionDecision = { type: "continue" };

  // Each Action gets its own recorder. Within one Action the first redirect
  // wins, and a deny always wins over a redirect, so a later redirect call
  // can't undo an explicit denial.
  const createApi = () => {
    let local: PreAccountActionDecision | undefined;
    return {
      api: {
        redirect: {
          sendUserTo: (url: unknown, options?: unknown) => {
            if (local) return;
            local = {
              type: "redirect",
              url: buildRedirectUrl(ctx.req.url, url, options),
            };
          },
        },
        access: {
          deny: (reason?: unknown) => {
            if (local?.type === "deny") return;
            local = {
              type: "deny",
              reason:
                typeof reason === "string" && reason.trim()
                  ? reason
                  : DEFAULT_ACCOUNT_ACTION_DENIAL,
            };
          },
        },
      },
      get: () => local,
    };
  };

  const failClosed = (actionName: string, error: unknown) => {
    outcomes.push({
      result: {
        action_name: actionName,
        error: {
          id: "execution_threw",
          msg: error instanceof Error ? error.message : String(error),
        },
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
      logs: [],
      denied: false,
    });
    decision = { type: "deny", reason: DEFAULT_ACCOUNT_ACTION_DENIAL };
  };

  if (configHook) {
    const recorder = createApi();
    const started_at = new Date().toISOString();
    try {
      await configHook(
        {
          ctx,
          operation,
          user,
          connection,
          client,
          tenant: { id: tenantId },
          request,
          details,
        },
        { ...recorder.api, token: createTokenAPI(ctx, tenantId) },
      );
      const result = recorder.get();
      outcomes.push({
        result: {
          action_name: "onExecutePreAccountAction",
          error: null,
          started_at,
          ended_at: new Date().toISOString(),
        },
        logs: [],
        denied: result?.type === "deny",
      });
      if (result) decision = result;
    } catch (error) {
      failClosed("onExecutePreAccountAction", error);
    }
  }

  const data = getExecutorData(ctx);
  for (const hook of codeHooks) {
    if (decision.type !== "continue") break;
    const recorder = createApi();
    try {
      if (!ctx.env.codeExecutor) throw new Error("No code executor configured");
      const outcome = await executeCodeHook({
        codeExecutor: ctx.env.codeExecutor,
        data,
        tenantId,
        hook,
        triggerId: PRE_ACCOUNT_ACTION_TRIGGER,
        event: {
          operation,
          user: user ? stripInternalUserFields(user) : undefined,
          connection,
          client,
          tenant: { id: tenantId },
          request,
          details,
        },
        api: recorder.api,
      });
      outcomes.push(outcome);
      const result = recorder.get();
      if (outcome.result.error) {
        decision = { type: "deny", reason: DEFAULT_ACCOUNT_ACTION_DENIAL };
      } else if (result) {
        decision = result;
      }
    } catch (error) {
      failClosed(hook.code_id, error);
    }
  }

  const executionId = await persistActionExecution(
    data,
    tenantId,
    PRE_ACCOUNT_ACTION_TRIGGER,
    outcomes,
    { logCapture: ctx.env.actionExecutionLogs },
  );
  if (executionId) ctx.set("action_execution_id", executionId);

  if (decision.type === "deny") {
    await logMessage(ctx, tenantId, {
      type: LogTypes.FAILED_HOOK,
      description: `pre-account-action denied ${operation}`,
      userId: user?.user_id,
    });
  }

  return decision;
}

/**
 * Run the trigger from a universal-login route and act on the result: throws
 * `RedirectException` to send the user elsewhere and `AccountActionDeniedError`
 * to stop the operation. Both are rendered by the universal-login error
 * handler. Returns normally when the operation may continue.
 */
export async function enforcePreAccountAction(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  params: Parameters<typeof runPreAccountAction>[1],
): Promise<void> {
  const decision = await runPreAccountAction(ctx, params);
  if (decision.type === "deny") {
    throw new AccountActionDeniedError(decision.reason);
  }
  if (decision.type === "redirect") {
    throw new RedirectException(decision.url);
  }
}
