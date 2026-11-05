import { Context } from "hono";
import {
  LoginSession,
  LoginSessionState,
  LogTypes,
  RateLimitDecision,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import { logMessage } from "../helpers/logging";
import {
  readLoginSessionData,
  updateLoginSessionData,
} from "../state-machines/login-session-data";
import { LoginSessionEventType } from "../state-machines/login-session";
import { failLoginSession } from "./common";

type MfaContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Failed MFA code verifications allowed per login session. The attempt that
 * reaches this count fails the login session.
 */
export const MFA_MAX_FAILED_ATTEMPTS = 5;

/** MFA SMS messages (first send plus resends) allowed per login session. */
export const MFA_MAX_SMS_SENDS = 5;

/** `failure_reason` stored on a login session locked out by MFA failures. */
export const MFA_LOCKOUT_REASON = "too_many_mfa_failures";

/** Thrown by sendMfaOtp when the SMS send limit has been reached. */
export class MfaSmsRateLimitError extends Error {
  constructor() {
    super("Too many MFA SMS messages sent");
    this.name = "MfaSmsRateLimitError";
  }
}

function isRateLimitDecision(value: unknown): value is RateLimitDecision {
  return (
    typeof value === "object" &&
    value !== null &&
    "allowed" in value &&
    typeof value.allowed === "boolean"
  );
}

/**
 * Consume one unit of the optional per-user rate limit. Fails open when the
 * adapter is missing or throws, like the other brute-force call sites.
 */
async function consumeRateLimit(ctx: MfaContext, key: string) {
  const rateLimit = ctx.env.data.rateLimit;
  if (!rateLimit) return true;
  try {
    const result: unknown = await rateLimit.consume("brute-force", key);
    return isRateLimitDecision(result) ? result.allowed : true;
  } catch (error) {
    console.error("MFA rate limit consume failed:", error);
    return true;
  }
}

/** True when the session was locked out or has used all its attempts. */
export function isMfaLockedOut(
  loginSession: Pick<LoginSession, "state" | "failure_reason" | "state_data">,
): boolean {
  if (
    loginSession.state === LoginSessionState.FAILED &&
    loginSession.failure_reason === MFA_LOCKOUT_REASON
  ) {
    return true;
  }
  const failed = readLoginSessionData(
    loginSession.state_data,
  ).mfa_failed_attempts;
  return (failed ?? 0) >= MFA_MAX_FAILED_ATTEMPTS;
}

async function lockOut(
  ctx: MfaContext,
  tenantId: string,
  loginSession: LoginSession,
  userId: string,
  description: string,
) {
  logMessage(ctx, tenantId, {
    type: LogTypes.TOO_MANY_MFA_FAILURES,
    description,
    userId,
  });
  await failLoginSession(ctx, tenantId, loginSession, MFA_LOCKOUT_REASON);
}

/**
 * Call before verifying an MFA code. Returns false when the attempt must be
 * rejected without checking the code: the session is locked out, or the
 * per-user rate limit (when configured) is exhausted, in which case the
 * session is failed too.
 */
export async function checkMfaAttemptAllowed(
  ctx: MfaContext,
  tenantId: string,
  loginSession: LoginSession,
  userId: string,
): Promise<boolean> {
  if (isMfaLockedOut(loginSession)) return false;

  const allowed = await consumeRateLimit(ctx, `mfa:${tenantId}:${userId}`);
  if (!allowed) {
    await lockOut(
      ctx,
      tenantId,
      loginSession,
      userId,
      "MFA verification rate limit exceeded",
    );
    return false;
  }
  return true;
}

/**
 * Count a failed MFA verification on the login session. Fails the login
 * session and logs a lockout when the limit is reached.
 */
export async function recordMfaFailure(
  ctx: MfaContext,
  tenantId: string,
  loginSessionId: string,
  userId: string,
): Promise<{ lockedOut: boolean }> {
  const current = await ctx.env.data.loginSessions.get(
    tenantId,
    loginSessionId,
  );
  if (!current) return { lockedOut: true };

  const failed =
    (readLoginSessionData(current.state_data).mfa_failed_attempts ?? 0) + 1;
  await updateLoginSessionData(
    ctx.env.data.loginSessions,
    tenantId,
    loginSessionId,
    {
      type: LoginSessionEventType.UPDATE_CONTEXT,
      data: { mfa_failed_attempts: failed },
    },
  );

  if (failed < MFA_MAX_FAILED_ATTEMPTS) return { lockedOut: false };

  await lockOut(
    ctx,
    tenantId,
    current,
    userId,
    `Too many failed MFA attempts (${failed})`,
  );
  return { lockedOut: true };
}

/** Clear the failed-attempt counter after a successful verification. */
export async function resetMfaFailures(
  ctx: MfaContext,
  tenantId: string,
  loginSessionId: string,
): Promise<void> {
  await updateLoginSessionData(
    ctx.env.data.loginSessions,
    tenantId,
    loginSessionId,
    {
      type: LoginSessionEventType.UPDATE_CONTEXT,
      data: { mfa_failed_attempts: undefined },
    },
  );
}

/**
 * Count an MFA SMS send on the login session and consume the per-user (or,
 * without a user, per-number) rate limit. Throws MfaSmsRateLimitError when
 * either limit is reached. Counted before sending, so failed sends count too.
 */
export async function enforceMfaSmsSendLimit(
  ctx: MfaContext,
  tenantId: string,
  loginSessionId: string,
  phoneNumber: string,
): Promise<void> {
  const current = await ctx.env.data.loginSessions.get(
    tenantId,
    loginSessionId,
  );
  const sent = readLoginSessionData(current?.state_data).mfa_sms_sent ?? 0;
  const subject = current?.user_id ?? phoneNumber;

  if (
    sent >= MFA_MAX_SMS_SENDS ||
    !(await consumeRateLimit(ctx, `mfa-sms:${tenantId}:${subject}`))
  ) {
    logMessage(ctx, tenantId, {
      type: LogTypes.ERROR_SENDING_MFA_SMS,
      description: "MFA SMS send limit reached",
      userId: current?.user_id,
    });
    throw new MfaSmsRateLimitError();
  }

  if (current) {
    await updateLoginSessionData(
      ctx.env.data.loginSessions,
      tenantId,
      loginSessionId,
      {
        type: LoginSessionEventType.UPDATE_CONTEXT,
        data: { mfa_sms_sent: sent + 1 },
      },
    );
  }
}
