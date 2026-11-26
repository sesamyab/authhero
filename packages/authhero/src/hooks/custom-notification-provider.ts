import { HTTPException } from "hono/http-exception";
import {
  DataAdapters,
  Hook,
  LogTypes,
  User,
  getNotificationHookMessageTypes,
} from "@authhero/adapter-interfaces";
import { RequestContext } from "../types";
import { logMessage } from "../helpers/logging";
import { waitUntil } from "../helpers/wait-until";
import { stripInternalUserFields } from "../helpers/hook-user-payload";
import {
  CodeHookEventInput,
  executeCodeHook,
  HandleCodeHookOutcome,
  isCodeHook,
  persistActionExecution,
} from "./codehooks";

/**
 * Auth0's custom provider triggers. A tenant binds an action to one of them to
 * deliver outgoing emails / text messages from its own system. With nothing
 * bound, messages go to the tenant's normal provider exactly as before.
 *
 * - https://auth0.com/docs/customize/email/smtp-email-providers/custom/configure-action
 * - https://auth0.com/docs/customize/phone-messages/configure-phone-messaging-providers/configure-a-custom-phone-provider
 */
export const CUSTOM_EMAIL_PROVIDER_TRIGGER = "custom-email-provider";
export const CUSTOM_PHONE_PROVIDER_TRIGGER = "custom-phone-provider";

export type NotificationTrigger =
  | typeof CUSTOM_EMAIL_PROVIDER_TRIGGER
  | typeof CUSTOM_PHONE_PROVIDER_TRIGGER;

/** Auth0 truncates `drop` / `retry` reasons to 1024 characters. */
export const NOTIFICATION_REASON_MAX_LENGTH = 1024;

/**
 * Background retries after `api.notification.retry()`: Auth0 retries "up to 5
 * times in the next minutes". AuthHero retries from the request's background
 * window (`waitUntil`), which is about 30 seconds on Workers, so the delays are
 * kept short. The message is held in memory only and never persisted.
 */
export const NOTIFICATION_RETRY_DELAYS_MS: readonly number[] = [
  1000, 2000, 3000, 5000, 8000,
];

/**
 * Workers cancels `waitUntil` work 30 seconds after the response. Retries stop
 * (and log `fn`) once another delay plus a full action timeout would no longer
 * fit in this budget, so the terminal log is always written inside the window.
 */
export const NOTIFICATION_RETRY_BUDGET_MS = 25_000;
const ACTION_TIMEOUT_MS = 5000;

const REDACTED = "[REDACTED]";

/** `event.notification` for `custom-email-provider`, Auth0's shape. */
export type EmailNotification = {
  message_type: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  locale: string;
};

/** `event.notification` for `custom-phone-provider`, Auth0's shape. */
export type PhoneNotification = {
  message_type: string;
  recipient: string;
  from: string;
  as_text: string;
  as_voice: string;
  code?: string;
  delivery_method: "text" | "voice";
  locale: string;
};

/**
 * Thrown when a message could not be delivered by the custom provider action:
 * it was dropped, threw, timed out, or no action could take it. The message is
 * generic on purpose: the one-time code and message content must never end up
 * in an error message.
 */
export class NotificationDeliveryError extends HTTPException {
  constructor(public readonly trigger: NotificationTrigger) {
    super(500, {
      message:
        trigger === CUSTOM_EMAIL_PROVIDER_TRIGGER
          ? "Failed to send email"
          : "Failed to send text message",
    });
    this.name = "NotificationDeliveryError";
  }
}

type CodeHook = Extract<Hook, { code_id: string }>;

/** The outcome of one run of the bound action. */
export type NotificationAttempt =
  | { type: "delivered" }
  | { type: "use_default_provider" }
  | { type: "dropped"; reason: string }
  | { type: "retry"; reason: string }
  | { type: "failed"; reason: string };

/**
 * Replace every occurrence of a secret (the one-time code, a link carrying a
 * token, the rendered message) with a marker. Longest first, so a rendered
 * body is removed whole before the code inside it is looked for. Values
 * shorter than 4 characters are skipped: they would match unrelated text.
 */
export function redactNotificationSecrets(
  value: string,
  secrets: readonly string[],
): string {
  const ordered = [...new Set(secrets)]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = value;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Length of the content fragments a scrubbed value may not share with a secret. */
const CONTENT_FRAGMENT_LENGTH = 20;
const WITHHELD = "[withheld: contains message content]";

/**
 * Build the scrubber applied to everything an action reports back (console
 * lines, error messages, drop/retry reasons):
 *
 * 1. Exact secrets (and their JSON-escaped forms, as `JSON.stringify(event)`
 *    would print them) are replaced by `[REDACTED]`.
 * 2. A value that still shares a run of 20 characters with a long secret (the
 *    rendered message, a link) is withheld entirely. Executors truncate console
 *    lines, so an echoed message often survives only as a fragment that exact
 *    matching can't catch.
 */
export function createNotificationScrubber(
  secrets: readonly string[],
): (value: string) => string {
  const all = secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  let fragments: Set<string> | undefined;
  const getFragments = () => {
    if (!fragments) {
      fragments = new Set();
      for (const secret of all) {
        for (let i = 0; i + CONTENT_FRAGMENT_LENGTH <= secret.length; i++) {
          fragments.add(secret.slice(i, i + CONTENT_FRAGMENT_LENGTH));
        }
      }
    }
    return fragments;
  };
  return (value: string) => {
    const redacted = redactNotificationSecrets(value, all);
    if (redacted.length < CONTENT_FRAGMENT_LENGTH) return redacted;
    const known = getFragments();
    for (let i = 0; i + CONTENT_FRAGMENT_LENGTH <= redacted.length; i++) {
      if (known.has(redacted.slice(i, i + CONTENT_FRAGMENT_LENGTH))) {
        return WITHHELD;
      }
    }
    return redacted;
  };
}

function normalizeReason(
  reason: unknown,
  scrub: (value: string) => string,
): string {
  const text = typeof reason === "string" ? reason : "";
  return scrub(text).slice(0, NOTIFICATION_REASON_MAX_LENGTH);
}

function getData(ctx: RequestContext): DataAdapters {
  return ctx.var.executorData ?? ctx.var.data ?? ctx.env.data;
}

/**
 * The enabled action bound to `trigger` that handles `messageType`, highest
 * priority first. A binding whose `metadata.message_types` (AuthHero
 * extension) doesn't list the type is skipped, so that message stays with the
 * tenant's normal provider. No list means every type, as in Auth0.
 */
export async function findNotificationHook(
  ctx: RequestContext,
  tenantId: string,
  trigger: NotificationTrigger,
  messageType: string,
): Promise<CodeHook | undefined> {
  const data = getData(ctx);
  // Contexts built on a partial adapter (e.g. the control-plane invitation
  // sender) have no hooks to bind, so nothing can take the message.
  if (!data.hooks) return undefined;
  const hooks: Hook[] = [];
  for (let page = 0; ; page++) {
    const result = await data.hooks.list(tenantId, {
      page,
      per_page: 100,
      q: `trigger_id:${trigger}`,
    });
    hooks.push(...result.hooks);
    if (result.hooks.length < 100) break;
  }
  return hooks
    .filter((h) => h.enabled && h.trigger_id === trigger)
    .filter(isCodeHook)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .find((h) => {
      const types = getNotificationHookMessageTypes(h.metadata);
      return !types || types.includes(messageType);
    });
}

function failedOutcome(
  actionName: string,
  error: unknown,
): HandleCodeHookOutcome {
  const now = new Date().toISOString();
  return {
    result: {
      action_name: actionName,
      error: {
        id: "execution_threw",
        msg: error instanceof Error ? error.message : String(error),
      },
      started_at: now,
      ended_at: now,
    },
    logs: [],
    denied: false,
  };
}

/**
 * Run the bound action once and read what it decided. Everything the action
 * reports back (error messages, console output, reasons) is redacted before it
 * is persisted or returned.
 */
export async function runNotificationAction(
  ctx: RequestContext,
  params: {
    trigger: NotificationTrigger;
    tenantId: string;
    hook: CodeHook;
    event: CodeHookEventInput;
    secrets: readonly string[];
  },
): Promise<NotificationAttempt> {
  const { trigger, tenantId, hook, event, secrets } = params;
  const data = getData(ctx);
  const scrub = createNotificationScrubber(secrets);

  // Only the last call counts, as in Auth0. Closed once the host has read the
  // decision so a late replay can't change it.
  let decision: NotificationAttempt | undefined;
  let closed = false;
  const api = {
    notification: {
      drop: (reason?: unknown) => {
        if (closed) return;
        decision = { type: "dropped", reason: normalizeReason(reason, scrub) };
      },
      retry: (reason?: unknown) => {
        if (closed) return;
        decision = { type: "retry", reason: normalizeReason(reason, scrub) };
      },
      useDefaultProvider: () => {
        if (closed) return;
        decision = { type: "use_default_provider" };
      },
    },
  };

  let outcome: HandleCodeHookOutcome;
  try {
    if (!ctx.env.codeExecutor) throw new Error("No code executor configured");
    outcome = await executeCodeHook({
      codeExecutor: ctx.env.codeExecutor,
      data,
      tenantId,
      hook,
      event,
      triggerId: trigger,
      api,
    });
  } catch (error) {
    outcome = failedOutcome(hook.code_id, error);
  }
  closed = true;

  let attempt: NotificationAttempt;
  if (outcome.result.error) {
    attempt = {
      type: "failed",
      reason: normalizeReason(outcome.result.error.msg, scrub),
    };
  } else {
    attempt = decision ?? { type: "delivered" };
    if (attempt.type === "dropped" || attempt.type === "retry") {
      outcome.result.error = {
        id:
          attempt.type === "dropped"
            ? "notification_dropped"
            : "notification_retry",
        msg: attempt.reason,
      };
    }
  }

  // Strip secrets from the execution record: user code may log the event.
  if (outcome.result.error) {
    outcome.result.error.msg = scrub(outcome.result.error.msg);
  }
  outcome.logs = outcome.logs.map((line) => ({
    ...line,
    message: scrub(line.message),
  }));

  try {
    await persistActionExecution(data, tenantId, trigger, [outcome], {
      logCapture: ctx.env.actionExecutionLogs,
    });
  } catch (error) {
    console.error(`[${trigger}] failed to persist action execution`, error);
  }

  return attempt;
}

export type DeliverNotificationParams = {
  trigger: NotificationTrigger;
  tenantId: string;
  messageType: string;
  /**
   * Builds `event.notification` (already rendered). Only called when an
   * action is bound, so plain sends don't pay for it.
   */
  buildNotification: () => Promise<EmailNotification | PhoneNotification>;
  /** The recipient's address or number, recorded in the tenant logs. */
  recipient: string;
  /**
   * Values that must never reach logs, execution records or errors: the
   * one-time code, links carrying a token, and the rendered content. The
   * rendered content in `notification` is added automatically.
   */
  secrets?: string[];
  /** The user the message is for, or a loader for it (runs only when an action is bound). */
  user?: User | (() => Promise<User | undefined>);
  /** Send with the tenant's normal provider, unchanged from before. */
  sendDefault: () => Promise<void>;
  /**
   * There is no normal provider to fall back to (the email provider is named
   * `custom`, as Auth0 tooling configures it): the message must go to an
   * action, and `useDefaultProvider()` is an error.
   */
  requireAction?: boolean;
  /** Override the background retry delays (tests). */
  retryDelaysMs?: readonly number[];
  /** Override the background retry budget (tests). */
  retryBudgetMs?: number;
  /**
   * Whether this message is still worth delivering, checked before each
   * background retry. A resend that replaced the one-time code makes an older
   * pending delivery stale: delivering it later would show the user a code
   * that no longer works.
   */
  isCurrent?: () => Promise<boolean>;
};

function contentSecrets(
  notification: EmailNotification | PhoneNotification,
): string[] {
  if ("html" in notification) {
    return [notification.html, notification.text, notification.subject];
  }
  const values = [notification.as_text, notification.as_voice];
  if (notification.code) values.push(notification.code);
  return values;
}

async function buildEvent(
  ctx: RequestContext,
  params: DeliverNotificationParams,
  notification: EmailNotification | PhoneNotification,
): Promise<CodeHookEventInput> {
  const data = getData(ctx);
  const user =
    typeof params.user === "function" ? await params.user() : params.user;
  const clientId = ctx.var.client_id;
  const [tenant, client] = await Promise.all([
    data.tenants.get(params.tenantId),
    clientId ? data.clients.get(params.tenantId, clientId) : null,
  ]);
  let hostname = "";
  try {
    hostname = new URL(ctx.req.url).hostname;
  } catch {
    // leave empty
  }
  return {
    notification,
    user: user ? stripInternalUserFields(user) : undefined,
    client: client ?? undefined,
    tenant: {
      id: params.tenantId,
      friendly_name: tenant?.friendly_name,
      support_email: tenant?.support_email,
      support_url: tenant?.support_url,
      logo_url: tenant?.picture_url,
    },
    request: {
      ip: ctx.var.ip ?? "",
      user_agent: ctx.var.useragent ?? "",
      method: ctx.req.method,
      hostname,
      language: ctx.req.header("accept-language"),
    },
  };
}

/**
 * With outbox logging, `logMessage` queues its write on the request and the
 * outbox middleware drains that queue once. Background retries log after that,
 * so they wait for their own writes here (the background task is what keeps
 * the Worker alive).
 */
async function awaitQueuedOutboxWrites(ctx: RequestContext) {
  const pending = ctx.var.outboxEventPromises;
  if (pending && pending.length > 0) await Promise.allSettled([...pending]);
}

async function logNotificationFailure(
  ctx: RequestContext,
  params: DeliverNotificationParams,
  description: string,
  reason: string | undefined,
  type:
    | typeof LogTypes.FAILED_SENDING_NOTIFICATION
    | typeof LogTypes.WARNING_SENDING_NOTIFICATION,
  options: { background?: boolean } = {},
) {
  const channel =
    params.trigger === CUSTOM_EMAIL_PROVIDER_TRIGGER ? "email" : "sms";
  try {
    await logMessage(ctx, params.tenantId, {
      type,
      description: `${channel} ${description} (${params.messageType})`.slice(
        0,
        500,
      ),
      details: {
        trigger_id: params.trigger,
        message_type: params.messageType,
        to: params.recipient,
        ...(reason ? { reason } : {}),
      },
      waitForCompletion: true,
    });
    if (options.background) await awaitQueuedOutboxWrites(ctx);
  } catch (error) {
    console.error(`[${params.trigger}] failed to record log entry`, error);
  }
}

/** Log an attempt that ended the delivery without sending; returns nothing to retry. */
async function reportTerminal(
  ctx: RequestContext,
  params: DeliverNotificationParams,
  attempt: Extract<NotificationAttempt, { type: "dropped" | "failed" }>,
  options: { background?: boolean } = {},
) {
  await logNotificationFailure(
    ctx,
    params,
    attempt.type === "dropped"
      ? `${params.trigger} action dropped the message`
      : `${params.trigger} action failed`,
    attempt.reason,
    LogTypes.FAILED_SENDING_NOTIFICATION,
    options,
  );
}

async function useDefaultProvider(
  ctx: RequestContext,
  params: DeliverNotificationParams,
): Promise<void> {
  if (params.requireAction) {
    await logNotificationFailure(
      ctx,
      params,
      `${params.trigger} action asked for the default provider, but the tenant has none`,
      undefined,
      LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    throw new NotificationDeliveryError(params.trigger);
  }
  await params.sendDefault();
}

/**
 * The background retry loop, guarded: the request already reported the
 * message as accepted, so any unexpected failure here (a rejected `isCurrent`
 * read, a database error) must still end in an `fn` log rather than vanish.
 */
async function retryInBackground(
  ctx: RequestContext,
  params: DeliverNotificationParams,
  hook: CodeHook,
  event: CodeHookEventInput,
  secrets: readonly string[],
) {
  try {
    await runRetries(ctx, params, hook, event, secrets);
  } catch (error) {
    const scrub = createNotificationScrubber(secrets);
    await logNotificationFailure(
      ctx,
      params,
      `${params.trigger} background retry failed`,
      scrub(error instanceof Error ? error.message : String(error)).slice(
        0,
        NOTIFICATION_REASON_MAX_LENGTH,
      ),
      LogTypes.FAILED_SENDING_NOTIFICATION,
      { background: true },
    );
  }
}

async function runRetries(
  ctx: RequestContext,
  params: DeliverNotificationParams,
  hook: CodeHook,
  event: CodeHookEventInput,
  secrets: readonly string[],
) {
  const delays = params.retryDelaysMs ?? NOTIFICATION_RETRY_DELAYS_MS;
  const budget = params.retryBudgetMs ?? NOTIFICATION_RETRY_BUDGET_MS;
  const background = { background: true };
  const started = Date.now();
  let retries = 0;
  const fail = (description: string, reason?: string) =>
    logNotificationFailure(
      ctx,
      params,
      description,
      reason,
      LogTypes.FAILED_SENDING_NOTIFICATION,
      background,
    );

  for (const delay of delays) {
    if (Date.now() - started + delay + ACTION_TIMEOUT_MS > budget) break;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // A resend replaced this message: delivering it now would be wrong.
    if (params.isCurrent && !(await params.isCurrent())) return;
    retries++;
    const attempt = await runNotificationAction(ctx, {
      trigger: params.trigger,
      tenantId: params.tenantId,
      hook,
      event,
      secrets,
    });
    switch (attempt.type) {
      case "delivered":
        return;
      case "use_default_provider":
        // A resend may have replaced the message while the action ran.
        if (params.isCurrent && !(await params.isCurrent())) return;
        try {
          await useDefaultProvider(ctx, params);
        } catch (error) {
          // The request already reported the message as sent, so this is the
          // only record that it wasn't. Scrub the provider's error message.
          const scrub = createNotificationScrubber(secrets);
          await fail(
            `${params.trigger} action handed the message to the default provider, which failed`,
            scrub(error instanceof Error ? error.message : String(error)).slice(
              0,
              NOTIFICATION_REASON_MAX_LENGTH,
            ),
          );
        }
        return;
      case "dropped":
      case "failed":
        await reportTerminal(ctx, params, attempt, background);
        return;
      case "retry":
        await logNotificationFailure(
          ctx,
          params,
          `${params.trigger} action asked to retry`,
          attempt.reason,
          LogTypes.WARNING_SENDING_NOTIFICATION,
          background,
        );
    }
  }
  await fail(`${params.trigger} action gave up after ${retries} retries`);
}

/**
 * Deliver one outgoing message: through the action bound to the custom
 * provider trigger when there is one for this message type, otherwise through
 * the tenant's normal provider (`sendDefault`), unchanged.
 *
 * - Delivered: returns; the caller logs the send as it always has.
 * - `useDefaultProvider()`: sends with the normal provider.
 * - `drop()`, a throw, a timeout or a missing executor: logs `fn` and throws
 *   `NotificationDeliveryError`, so the user sees that sending failed rather
 *   than waiting for a message that never comes. It never falls back to the
 *   normal provider on its own.
 * - `retry()`: logs `wn`, returns as accepted, and retries in the background
 *   up to 5 times; `fn` if every retry fails.
 */
export async function deliverNotification(
  ctx: RequestContext,
  params: DeliverNotificationParams,
): Promise<void> {
  const hook = await findNotificationHook(
    ctx,
    params.tenantId,
    params.trigger,
    params.messageType,
  );

  if (!hook) {
    if (params.requireAction) {
      await logNotificationFailure(
        ctx,
        params,
        `no enabled ${params.trigger} action handles this message`,
        undefined,
        LogTypes.FAILED_SENDING_NOTIFICATION,
      );
      throw new NotificationDeliveryError(params.trigger);
    }
    return params.sendDefault();
  }

  const notification = await params.buildNotification();
  const secrets = [...(params.secrets ?? []), ...contentSecrets(notification)];
  const event = await buildEvent(ctx, params, notification);
  const attempt = await runNotificationAction(ctx, {
    trigger: params.trigger,
    tenantId: params.tenantId,
    hook,
    event,
    secrets,
  });

  switch (attempt.type) {
    case "delivered":
      return;
    case "use_default_provider":
      return useDefaultProvider(ctx, params);
    case "dropped":
    case "failed":
      await reportTerminal(ctx, params, attempt);
      throw new NotificationDeliveryError(params.trigger);
    case "retry":
      await logNotificationFailure(
        ctx,
        params,
        `${params.trigger} action asked to retry`,
        attempt.reason,
        LogTypes.WARNING_SENDING_NOTIFICATION,
      );
      waitUntil(ctx, retryInBackground(ctx, params, hook, event, secrets));
      return;
  }
}

/** A rough plain-text rendering of an HTML email for `event.notification.text`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n")
    .replace(/<a\s[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, "$3 ($2)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
