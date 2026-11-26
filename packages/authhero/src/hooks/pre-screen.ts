import { Context } from "hono";
import {
  escapeLuceneValue,
  getPreScreenHookScreens,
  getPreScreenScreen,
  Hook,
  isPreScreenHookFailClosed,
  LoginSession,
  LogTypes,
  PRE_SCREEN_TRIGGER_ID,
  PreScreenOperation,
  PreScreenPhase,
  User,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import {
  HookRequest,
  PreScreenEvent,
  PreScreenTransaction,
} from "../types/Hooks";
import { EnrichedClient } from "../helpers/client";
import { getExecutorData } from "../helpers/request-data";
import { logMessage } from "../helpers/logging";
import { getPrimaryUserByEmail } from "../helpers/users";
import { getAuthCookie } from "../utils/cookies";
import { createTokenAPI } from "./helpers/token-api";
import { stripInternalUserFields } from "../helpers/hook-user-payload";
import {
  executeCodeHook,
  HandleCodeHookOutcome,
  isCodeHook,
  persistActionExecution,
} from "./codehooks";
import { listEnabledCodeHooks } from "./lifecycle-codehooks";
import { RedirectException } from "../errors/redirect-exception";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;
type CodeHook = Extract<Hook, { code_id: string }>;

export const PRE_SCREEN_TRIGGER = PRE_SCREEN_TRIGGER_ID;

/**
 * Host wait for the `onExecutePreScreen` config callback, matching the bound
 * on code Actions. A callback that never settles must not leave the screen
 * hanging.
 */
export const PRE_SCREEN_TIMEOUT_MS = 5000;

/** Shown when an action denies without a reason, or fails closed. */
export const DEFAULT_PRE_SCREEN_DENIAL =
  "This isn't available for your account.";

/**
 * Page size of an unparameterized `hooks.list`, which the client bundle
 * caches. A full page may be truncated, so the trigger then pages through the
 * hooks bound to it instead.
 */
const DEFAULT_HOOKS_PAGE_SIZE = 50;

export type PreScreenDecision =
  | { type: "continue" }
  | { type: "redirect"; url: string }
  | { type: "deny"; reason: string };

/** What a submission does, for the submit phase's `event.operation`. */
export type PreScreenSubmission = {
  operation: PreScreenOperation;
  details?: Record<string, string>;
};

/**
 * Thrown when a `pre-screen` Action denies a screen or its submission. The
 * universal-login error handler renders `reason` on the branded error page
 * (other error messages are replaced by a generic text there, which would
 * hide the tenant's explanation).
 */
export class ScreenDeniedError extends Error {
  readonly status = 403;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ScreenDeniedError";
  }
}

/** A loader that only runs when something is bound to the screen. */
type Lazy<T> = () => Promise<T>;

async function resolveLazy<T>(
  load: Lazy<T> | undefined,
): Promise<T | undefined> {
  return load ? load() : undefined;
}

export interface PreScreenParams {
  tenantId: string;
  /** Screen name from `PRE_SCREEN_SCREENS`, e.g. `login-id`. */
  screen: string;
  phase: PreScreenPhase;
  /**
   * Everything below is only loaded when something is bound to the screen,
   * so unbound screens pay nothing beyond the (cached) hook list.
   */
  client?: Lazy<EnrichedClient | undefined>;
  loginSession?: Lazy<LoginSession | undefined>;
  user?: Lazy<User | undefined>;
  /** Submit phase: the operation the submission performs, if any. */
  submission?: Lazy<PreScreenSubmission | undefined>;
}

/**
 * The enabled code hooks bound to `pre-screen` that run for `screen`, highest
 * priority first. Reads the unparameterized hook list, which the client bundle
 * serves from cache, and only queries when that page is full.
 */
export async function findPreScreenHooks(
  ctx: Ctx,
  tenantId: string,
  screen: string,
): Promise<CodeHook[]> {
  const data = getExecutorData(ctx);
  const { hooks } = await data.hooks.list(tenantId);
  const bound =
    hooks.length >= DEFAULT_HOOKS_PAGE_SIZE
      ? await listEnabledCodeHooks(ctx, tenantId, PRE_SCREEN_TRIGGER)
      : hooks
          .filter((h) => h.enabled && h.trigger_id === PRE_SCREEN_TRIGGER)
          .filter(isCodeHook)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return bound.filter((hook) => {
    const screens = getPreScreenHookScreens(hook.metadata);
    return !screens || screens.includes(screen);
  });
}

/**
 * Resolve a redirect target from an Action. Only the URL and query the Action
 * returned are used: relative URLs resolve against the current request and
 * anything other than http(s) is rejected, so an Action can't send the
 * browser to `javascript:` or `data:` URLs. Nothing from the request (its
 * query, `redirect_uri`, the login session) is added, so the trigger can't be
 * used as an open redirect. No `state` is appended: the user leaves this
 * transaction, which stays resumable until the login session expires.
 */
export function buildPreScreenRedirectUrl(
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
): PreScreenEvent["connection"] {
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

function screenHintFrom(loginSession: LoginSession | undefined) {
  if (!loginSession?.authorization_url) return undefined;
  try {
    return (
      new URL(loginSession.authorization_url).searchParams.get("screen_hint") ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function buildTransaction(
  phase: PreScreenPhase,
  loginSession: LoginSession | undefined,
): PreScreenTransaction {
  const authParams = loginSession?.authParams;
  return {
    phase,
    locale: authParams?.ui_locales?.split(" ")[0] || "en",
    client_id: authParams?.client_id,
    redirect_uri: authParams?.redirect_uri,
    requested_scopes: authParams?.scope?.split(" ").filter(Boolean) ?? [],
    response_type: authParams?.response_type,
    response_mode: authParams?.response_mode,
    state: authParams?.state,
    audience: authParams?.audience,
    prompt: authParams?.prompt,
    ui_locales: authParams?.ui_locales,
    acr_values: authParams?.acr_values,
    login_hint: authParams?.username,
    screen_hint: screenHintFrom(loginSession),
  };
}

async function loadOrganization(
  ctx: Ctx,
  tenantId: string,
  loginSession: LoginSession | undefined,
): Promise<PreScreenEvent["organization"]> {
  const organizationId = loginSession?.authParams?.organization;
  if (!organizationId) return undefined;
  try {
    const org = await ctx.env.data.organizations.get(tenantId, organizationId);
    if (!org) return undefined;
    return {
      id: org.id,
      name: org.name,
      display_name: org.display_name,
      metadata: org.metadata,
    };
  } catch (error) {
    console.error("pre-screen: failed to load organization", error);
    return undefined;
  }
}

/**
 * Run the `pre-screen` trigger: the `onExecutePreScreen` config hook first,
 * then the code Actions bound to the screen in priority order. The first one
 * that redirects or denies decides and later ones don't run.
 *
 * An Action that throws, times out or fails denies a submission (fail
 * closed). In the render phase it is logged and the screen is shown, unless
 * the binding set `metadata.fail_closed`.
 */
export async function runPreScreen(
  ctx: Ctx,
  params: PreScreenParams,
): Promise<PreScreenDecision> {
  const { tenantId, screen, phase } = params;
  const configHook = ctx.env.hooks?.onExecutePreScreen;
  const codeHooks = await findPreScreenHooks(ctx, tenantId, screen);
  if (!configHook && codeHooks.length === 0) {
    return { type: "continue" };
  }

  const [client, loginSession] = await Promise.all([
    resolveLazy(params.client),
    resolveLazy(params.loginSession),
  ]);
  const [user, submission, organization] = await Promise.all([
    resolveLazy(params.user),
    phase === "submit" ? resolveLazy(params.submission) : undefined,
    loadOrganization(ctx, tenantId, loginSession),
  ]);
  const request: HookRequest = {
    method: ctx.req.method,
    ip: ctx.var.ip || "",
    user_agent: ctx.var.useragent || "",
    url: ctx.req.url,
  };
  const prompt = getPreScreenScreen(screen)?.prompt ?? screen;
  const eventBase = {
    screen: { name: screen },
    prompt: { name: prompt },
    transaction: buildTransaction(phase, loginSession),
    operation: submission?.operation,
    details: submission?.details,
    connection: resolveConnection(user, client),
    organization,
    tenant: { id: tenantId },
    request,
  };
  const label = submission
    ? `${phase} of ${screen} (${submission.operation})`
    : `${phase} of ${screen}`;

  const outcomes: HandleCodeHookOutcome[] = [];
  let decision: PreScreenDecision = { type: "continue" };

  // Each Action gets its own recorder. Within one Action the first redirect
  // wins, and a deny always wins over a redirect, so a later redirect call
  // can't undo an explicit denial.
  const createApi = () => {
    let local: PreScreenDecision | undefined;
    // Closed once the host has read the decision, so a late call from a
    // timed-out callback can't change it.
    let closed = false;
    return {
      api: {
        redirect: {
          sendUserTo: (url: unknown, options?: unknown) => {
            if (closed || local) return;
            local = {
              type: "redirect",
              url: buildPreScreenRedirectUrl(ctx.req.url, url, options),
            };
          },
        },
        access: {
          deny: (reason?: unknown) => {
            if (closed || local?.type === "deny") return;
            local = {
              type: "deny",
              reason:
                typeof reason === "string" && reason.trim()
                  ? reason
                  : DEFAULT_PRE_SCREEN_DENIAL,
            };
          },
        },
      },
      get: () => {
        closed = true;
        return local;
      },
    };
  };

  const fail = async (
    actionName: string,
    error: unknown,
    failClosed: boolean,
    recordOutcome: boolean,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    if (recordOutcome) {
      const now = new Date().toISOString();
      outcomes.push({
        result: {
          action_name: actionName,
          error: { id: "execution_threw", msg: message },
          started_at: now,
          ended_at: now,
        },
        logs: [],
        denied: false,
      });
    }
    if (failClosed) {
      decision = { type: "deny", reason: DEFAULT_PRE_SCREEN_DENIAL };
      return;
    }
    console.error(
      `pre-screen action ${actionName} failed on ${label}; showing the screen`,
      message,
    );
    await logMessage(ctx, tenantId, {
      type: LogTypes.FAILED_HOOK,
      description: `pre-screen action failed on ${label}; screen shown`,
      userId: user?.user_id,
    });
  };

  if (configHook) {
    const recorder = createApi();
    const started_at = new Date().toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = configHook(
        { ctx, ...eventBase, user, client },
        { ...recorder.api, token: createTokenAPI(ctx, tenantId) },
      );
      await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `onExecutePreScreen timed out after ${PRE_SCREEN_TIMEOUT_MS}ms`,
                ),
              ),
            PRE_SCREEN_TIMEOUT_MS,
          );
        }),
      ]);
      const result = recorder.get();
      outcomes.push({
        result: {
          action_name: "onExecutePreScreen",
          error: null,
          started_at,
          ended_at: new Date().toISOString(),
        },
        logs: [],
        denied: result?.type === "deny",
      });
      if (result) decision = result;
    } catch (error) {
      recorder.get();
      await fail("onExecutePreScreen", error, phase === "submit", true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const data = getExecutorData(ctx);
  for (const hook of codeHooks) {
    if (decision.type !== "continue") break;
    const failClosed =
      phase === "submit" || isPreScreenHookFailClosed(hook.metadata);
    const recorder = createApi();
    try {
      if (!ctx.env.codeExecutor) throw new Error("No code executor configured");
      const outcome = await executeCodeHook({
        codeExecutor: ctx.env.codeExecutor,
        data,
        tenantId,
        hook,
        triggerId: PRE_SCREEN_TRIGGER,
        event: {
          ...eventBase,
          user: user ? stripInternalUserFields(user) : undefined,
          client,
        },
        api: recorder.api,
      });
      outcomes.push(outcome);
      const result = recorder.get();
      if (outcome.result.error) {
        await fail(hook.code_id, outcome.result.error.msg, failClosed, false);
      } else if (result) {
        decision = result;
      }
    } catch (error) {
      recorder.get();
      await fail(hook.code_id, error, failClosed, true);
    }
  }

  // Storing the execution record must not change the decision: a fail-open
  // render would otherwise become a 500.
  try {
    const executionId = await persistActionExecution(
      data,
      tenantId,
      PRE_SCREEN_TRIGGER,
      outcomes,
      { logCapture: ctx.env.actionExecutionLogs },
    );
    if (executionId) ctx.set("action_execution_id", executionId);
  } catch (error) {
    console.error(
      `pre-screen: failed to store the action execution for ${label}`,
      error,
    );
  }

  if (decision.type === "deny") {
    await logMessage(ctx, tenantId, {
      type: LogTypes.FAILED_HOOK,
      description: `pre-screen denied ${label}`,
      userId: user?.user_id,
    });
  }

  return decision;
}

/**
 * Run the trigger and act on the result: throws `RedirectException` to send
 * the user elsewhere and `ScreenDeniedError` to stop. Both are rendered by the
 * universal-login error handler. Returns normally when the screen may go on.
 */
export async function enforcePreScreen(
  ctx: Ctx,
  params: PreScreenParams,
): Promise<void> {
  const decision = await runPreScreen(ctx, params);
  if (decision.type === "deny") {
    throw new ScreenDeniedError(decision.reason);
  }
  if (decision.type === "redirect") {
    throw new RedirectException(decision.url);
  }
}

// ---------------------------------------------------------------------------
// Who the screen is for
// ---------------------------------------------------------------------------

/**
 * The user an identifier (email, phone number or username) entered on a
 * login, signup or password-reset screen belongs to, resolved to the primary
 * user. Undefined when no user matches.
 */
export async function findUserByIdentifier(
  ctx: Ctx,
  tenantId: string,
  identifier: unknown,
): Promise<User | undefined> {
  if (typeof identifier !== "string") return undefined;
  const value = identifier.trim();
  if (!value) return undefined;
  const users = ctx.env.data.users;
  if (value.includes("@")) {
    return getPrimaryUserByEmail({
      userAdapter: users,
      tenant_id: tenantId,
      email: value.toLowerCase(),
    });
  }
  const field = /^\+?[0-9][0-9 ().-]{5,}$/.test(value)
    ? "phone_number"
    : "username";
  const { users: matches } = await users.list(tenantId, {
    page: 0,
    per_page: 10,
    include_totals: false,
    q: `${field}:${escapeLuceneValue(value)}`,
  });
  const primary = matches.find((u) => !u.linked_to);
  if (primary) return primary;
  const linkedTo = matches[0]?.linked_to;
  return linkedTo
    ? ((await users.get(tenantId, linkedTo)) ?? undefined)
    : undefined;
}

/**
 * The user of a login-flow screen: the identifier just submitted (pass it
 * only for screens where the user enters one), then the user the transaction
 * already authenticated (MFA, consent, passkey enrollment), then the
 * identifier entered earlier in the flow.
 */
export async function findLoginScreenUser(
  ctx: Ctx,
  tenantId: string,
  loginSession: LoginSession | undefined,
  submittedIdentifier?: unknown,
): Promise<User | undefined> {
  if (typeof submittedIdentifier === "string" && submittedIdentifier.trim()) {
    return findUserByIdentifier(ctx, tenantId, submittedIdentifier);
  }
  if (loginSession?.user_id) {
    const user = await ctx.env.data.users.get(tenantId, loginSession.user_id);
    if (user) return user;
  }
  return findUserByIdentifier(ctx, tenantId, loginSession?.authParams.username);
}

/**
 * The user of an account screen: the signed-in session's user, or, mid-login
 * (a form hook sent the user to an account page), the user the transaction
 * authenticated. The screen still enforces its own access rules afterwards.
 */
export async function findAccountScreenUser(
  ctx: Ctx,
  tenantId: string,
  loginSession: LoginSession | undefined,
): Promise<User | undefined> {
  const authCookie = getAuthCookie(tenantId, ctx.req.header("cookie"));
  if (authCookie) {
    const session = await ctx.env.data.sessions.get(tenantId, authCookie);
    if (session && !session.revoked_at) {
      const user = await ctx.env.data.users.get(tenantId, session.user_id);
      if (user) return user;
    }
  }
  if (loginSession?.user_id) {
    return (
      (await ctx.env.data.users.get(tenantId, loginSession.user_id)) ??
      undefined
    );
  }
  return undefined;
}
