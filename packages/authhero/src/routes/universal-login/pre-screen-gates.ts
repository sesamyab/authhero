/**
 * Wiring of the `pre-screen` trigger into universal login. Every u2 screen in
 * the registry and the classic `/u` pages with the same screen fire it before
 * the screen is shown (`render`) and when it is submitted (`submit`), so a
 * direct POST can't skip a submit-time denial.
 */

import { Context, MiddlewareHandler } from "hono";
import { LoginSession } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import {
  enforcePreScreen,
  findAccountScreenUser,
  findLoginScreenUser,
  PreScreenSubmission,
  runPreScreen,
  ScreenDeniedError,
} from "../../hooks/pre-screen";
import { getEnrichedClient } from "../../helpers/client";
import type { ScreenContext, ScreenDefinition } from "./screens/types";
import { PASSKEY_TYPES } from "./screens/passkey-utils";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

type DescribeSubmit = (
  ctx: Ctx,
  tenantId: string,
  data: Record<string, unknown>,
) => Promise<PreScreenSubmission | undefined>;

interface ScreenGate {
  /** `event.screen.name` (see `PRE_SCREEN_SCREENS`). */
  name: string;
  /** Where the user comes from. */
  user: "login" | "account";
  /** The operation a submission performs, if any. */
  describeSubmit?: DescribeSubmit;
}

const operation =
  (
    op: PreScreenSubmission["operation"],
    details?: Record<string, string>,
  ): DescribeSubmit =>
  async () => ({ operation: op, ...(details ? { details } : {}) });

function stringField(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

/** Remove on account-security also takes passkeys: decide by stored type. */
const describeAccountSecuritySubmit: DescribeSubmit = async (
  ctx,
  tenantId,
  data,
) => {
  const enrollmentId = stringField(data, "enrollment_id");
  if (stringField(data, "action") !== "remove_enrollment" || !enrollmentId) {
    return undefined;
  }
  const enrollment = await ctx.env.data.authenticationMethods
    .get(tenantId, enrollmentId)
    .catch(() => null);
  const isPasskey =
    !!enrollment && PASSKEY_TYPES.some((type) => type === enrollment.type);
  return {
    operation: isPasskey ? "remove-passkey" : "remove-mfa",
    details: {
      enrollment_id: enrollmentId,
      ...(enrollment ? { type: enrollment.type } : {}),
    },
  };
};

const describeAccountPasskeysSubmit: DescribeSubmit = async (
  _ctx,
  _tenantId,
  data,
) => {
  const action =
    stringField(data, "action") || stringField(data, "action-field") || "";
  const passkeyId = stringField(data, "passkey_id");
  if (action === "remove_passkey" && passkeyId) {
    return {
      operation: "remove-passkey",
      details: { enrollment_id: passkeyId },
    };
  }
  if (
    action === "" ||
    action === "start_add_passkey" ||
    action === "complete_add_passkey"
  ) {
    return { operation: "enroll-passkey" };
  }
  return undefined;
};

const describeAccountLinkedSubmit: DescribeSubmit = async (
  _ctx,
  _tenantId,
  data,
) => {
  const match = stringField(data, "action")?.match(
    /^unlink_account:(.+?):(.+)$/,
  );
  if (!match) return undefined;
  return {
    operation: "unlink-identity",
    details: { provider: match[1]!, user_id: match[2]! },
  };
};

/**
 * u2 screen id (the registry key) → pre-screen screen. Classic `/u` pages use
 * the id of the u2 screen they correspond to.
 */
const SCREEN_GATES: Record<string, ScreenGate> = {
  identifier: { name: "login-id", user: "login" },
  login: { name: "login", user: "login" },
  "enter-password": { name: "login-password", user: "login" },
  "login-passwordless-identifier": {
    name: "login-passwordless-identifier",
    user: "login",
  },
  "email-otp-challenge": {
    name: "login-passwordless-email-code",
    user: "login",
  },
  "sms-otp-challenge": { name: "login-passwordless-sms-otp", user: "login" },
  // Not in the registry: only shown as the answer to an identifier POST.
  "magic-link-sent": { name: "magic-link-sent", user: "login" },
  "passkey-challenge": { name: "passkey-challenge", user: "login" },
  "email-verification-code": { name: "email-verification-code", user: "login" },
  "email-verification-link-sent": {
    name: "email-verification-link-sent",
    user: "login",
  },
  impersonate: { name: "impersonate", user: "login" },
  signup: { name: "signup", user: "login" },
  "forgot-password": {
    name: "reset-password-request",
    user: "login",
    describeSubmit: operation("reset-password"),
  },
  "reset-password-code": { name: "reset-password-code", user: "login" },
  "reset-password": {
    name: "reset-password",
    user: "login",
    describeSubmit: operation("reset-password"),
  },
  "mfa-login-options": { name: "mfa-login-options", user: "login" },
  "mfa-totp-challenge": { name: "mfa-otp-challenge", user: "login" },
  "mfa-totp-enrollment": { name: "mfa-otp-enrollment-qr", user: "login" },
  "mfa-phone-challenge": { name: "mfa-phone-challenge", user: "login" },
  "mfa-phone-enrollment": { name: "mfa-phone-enrollment", user: "login" },
  "passkey-enrollment": { name: "passkey-enrollment", user: "login" },
  "passkey-enrollment-nudge": {
    name: "passkey-enrollment-nudge",
    user: "login",
  },
  consent: { name: "consent", user: "login" },
  "device-code": { name: "device-code-activation", user: "account" },
  "device-confirmation": { name: "device-code-confirmation", user: "account" },
  "device-complete": {
    name: "device-code-activation-allowed",
    user: "account",
  },
  "accept-invitation": { name: "accept-invitation", user: "login" },
  account: { name: "account", user: "account" },
  "account-profile": {
    name: "account-profile",
    user: "account",
    describeSubmit: operation("update-profile"),
  },
  "account-change-email": {
    name: "account-change-email",
    user: "account",
    describeSubmit: operation("change-email"),
  },
  "account-change-email-verify": {
    name: "account-change-email-verify",
    user: "account",
  },
  "account-security": {
    name: "account-security",
    user: "account",
    describeSubmit: describeAccountSecuritySubmit,
  },
  "account-mfa-totp-enrollment": {
    name: "account-mfa-totp-enrollment",
    user: "account",
    describeSubmit: operation("enroll-mfa", { factor: "totp" }),
  },
  "account-mfa-phone-enrollment": {
    name: "account-mfa-phone-enrollment",
    user: "account",
    describeSubmit: operation("enroll-mfa", { factor: "phone" }),
  },
  "account-linked": {
    name: "account-linked",
    user: "account",
    describeSubmit: describeAccountLinkedSubmit,
  },
  "account-passkeys": {
    name: "account-passkeys",
    user: "account",
    describeSubmit: describeAccountPasskeysSubmit,
  },
  "account-delete": {
    name: "account-delete",
    user: "account",
    describeSubmit: operation("delete-account"),
  },
  "connect-consent": { name: "connect-consent", user: "account" },
  "connect-tenant-select": { name: "connect-tenant-select", user: "account" },
  "self-service-app": { name: "self-service-app", user: "account" },
  "invalid-session": { name: "invalid-session", user: "login" },
  "try-connection-result": { name: "try-connection-result", user: "login" },
};

/** The pre-screen screen name of a u2 screen id, if it is gated. */
export function getPreScreenName(screenId: string): string | undefined {
  return SCREEN_GATES[screenId]?.name;
}

/** u2 screen ids that fire `pre-screen`. */
export function listPreScreenScreenIds(): string[] {
  return Object.keys(SCREEN_GATES);
}

function submittedIdentifier(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  return stringField(data, "username") ?? stringField(data, "email");
}

type EnrichedClient = Awaited<ReturnType<typeof getEnrichedClient>>;

function gateParams(
  ctx: Ctx,
  gate: ScreenGate,
  options: {
    tenantId: string;
    phase: "render" | "submit";
    client: () => Promise<EnrichedClient | undefined>;
    loginSession: () => Promise<LoginSession | undefined>;
    /** The submitted form, read only when something is bound. */
    data?: () => Promise<Record<string, unknown> | undefined>;
  },
) {
  const { tenantId, phase } = options;
  // Memoised: the user and the transaction both read the login session.
  let loginSessionPromise: Promise<LoginSession | undefined> | undefined;
  const loginSession = () => (loginSessionPromise ??= options.loginSession());
  const data = async () => (phase === "submit" ? options.data?.() : undefined);
  const describe = gate.describeSubmit;
  return {
    tenantId,
    screen: gate.name,
    phase,
    client: options.client,
    loginSession,
    user: async () =>
      gate.user === "account"
        ? findAccountScreenUser(ctx, tenantId, await loginSession())
        : findLoginScreenUser(
            ctx,
            tenantId,
            await loginSession(),
            submittedIdentifier(await data()),
          ),
    submission: describe
      ? async () => {
          const submitted = await data();
          return submitted ? describe(ctx, tenantId, submitted) : undefined;
        }
      : undefined,
  };
}

function screenParams(
  context: ScreenContext,
  gate: ScreenGate,
  phase: "render" | "submit",
  data?: Record<string, unknown>,
) {
  const { ctx, tenant, state } = context;
  return gateParams(ctx, gate, {
    tenantId: tenant.id,
    phase,
    data: async () => data,
    client: async () => context.client,
    loginSession: async () =>
      ctx.var.loginSession?.id === state
        ? ctx.var.loginSession
        : ((await ctx.env.data.loginSessions.get(tenant.id, state)) ??
          undefined),
  });
}

/**
 * Fire `pre-screen` for a u2 screen: `render` before its GET factory runs and
 * `submit` before its POST handler. When a POST answers with a different
 * screen (identifier → email code), that screen's `render` fires too, since
 * it is shown without a GET of its own.
 */
export function withPreScreen(
  screenId: string,
  definition: ScreenDefinition,
): ScreenDefinition {
  const gate = SCREEN_GATES[screenId];
  if (!gate) return definition;
  const { get, post } = definition.handler;
  return {
    ...definition,
    handler: {
      get: async (context) => {
        await enforcePreScreen(
          context.ctx,
          screenParams(context, gate, "render"),
        );
        return get(context);
      },
      ...(post
        ? {
            post: async (context, data) => {
              const submitted = await runPreScreen(
                context.ctx,
                screenParams(context, gate, "submit", data),
              );
              if (submitted.type === "deny") {
                throw new ScreenDeniedError(submitted.reason);
              }
              if (submitted.type === "redirect") {
                return { redirect: submitted.url };
              }

              const result = await post(context, data);
              if (!("screen" in result) || "error" in result) return result;
              const nextId = result.screen.screen.name;
              const nextGate =
                nextId && nextId !== screenId
                  ? SCREEN_GATES[nextId]
                  : undefined;
              if (!nextGate) return result;
              const rendered = await runPreScreen(
                context.ctx,
                screenParams(context, nextGate, "render"),
              );
              if (rendered.type === "deny") {
                throw new ScreenDeniedError(rendered.reason);
              }
              if (rendered.type === "redirect") {
                return { redirect: rendered.url };
              }
              return result;
            },
          }
        : {}),
    },
  };
}

/**
 * Fire `pre-screen` for a classic `/u` page: `render` on GET and `submit` on
 * POST, before the route handler. Requests without a login session (`state`)
 * are left to the route, which rejects them.
 */
export function preScreenMiddleware(
  screenId: string,
  options: { submit?: boolean } = {},
): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  const gate = SCREEN_GATES[screenId];
  if (!gate) throw new Error(`No pre-screen gate for ${screenId}`);
  const { submit = true } = options;
  return async (ctx, next) => {
    const phase =
      ctx.req.method === "GET"
        ? "render"
        : ctx.req.method === "POST" && submit
          ? "submit"
          : undefined;
    const tenantId = ctx.var.tenant_id;
    const state = ctx.req.query("state");
    if (!phase || !tenantId || !state) return next();

    const loginSession = async () =>
      (await ctx.env.data.loginSessions.get(tenantId, state)) ?? undefined;
    await enforcePreScreen(
      ctx,
      gateParams(ctx, gate, {
        tenantId,
        phase,
        loginSession,
        client: async () => {
          const session = await loginSession();
          return session
            ? getEnrichedClient(ctx.env, session.authParams.client_id, tenantId)
            : undefined;
        },
        // Hono caches the parsed body, so the route's validator still sees it.
        data: async () => {
          const contentType = ctx.req.header("content-type") || "";
          if (!contentType.includes("form")) return undefined;
          const record: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(
            await ctx.req.parseBody(),
          )) {
            record[key] = value;
          }
          return record;
        },
      }),
    );
    return next();
  };
}
