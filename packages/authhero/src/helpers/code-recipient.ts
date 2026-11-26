import type { Context } from "hono";
import type { Code, CodesAdapter } from "@authhero/adapter-interfaces";
import type { CountryCode } from "libphonenumber-js";
import { getConnectionFromIdentifier } from "../utils/username";

/**
 * Login and pre-signup codes are delivered to one address, and only that
 * address may redeem them. The address is stored on the code when it is
 * created (`state.recipient`), normalized like the identifier it is later
 * compared with, because the login session's username can change after the
 * code was sent.
 *
 * Codes without a stored recipient (minted before the recipient was stored)
 * are not accepted: login codes expire within 30 minutes and are simply
 * requested again, and a pre-signup code without one only means the signup
 * continues unverified and a verification email is sent instead.
 */

/** `state.purpose` of a pre-signup `email_verification` code. */
export const PRE_SIGNUP_CODE_PURPOSE = "pre_signup";

export function normalizeCodeRecipient(
  identifier: string,
  countryCode?: CountryCode,
): string {
  const { normalized } = getConnectionFromIdentifier(identifier, countryCode);
  return normalized ?? identifier.trim().toLowerCase();
}

export function codeRecipientState(
  recipient: string,
  countryCode?: CountryCode,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ...extra,
    recipient: normalizeCodeRecipient(recipient, countryCode),
  });
}

export function parseCodeState(
  code: Pick<Code, "state">,
): Record<string, unknown> {
  if (!code.state) return {};
  try {
    const parsed: unknown = JSON.parse(code.state);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The address the code was sent to, if it was stored when it was created. */
export function getCodeRecipient(
  code: Pick<Code, "state">,
): string | undefined {
  const { recipient } = parseCodeState(code);
  return typeof recipient === "string" && recipient ? recipient : undefined;
}

/** Whether `identifier` is the address the code was sent to. */
export function isCodeRecipient(
  code: Pick<Code, "state">,
  identifier: string | undefined,
  countryCode?: CountryCode,
): boolean {
  const recipient = getCodeRecipient(code);
  if (!recipient || !identifier) return false;
  return recipient === normalizeCodeRecipient(identifier, countryCode);
}

/**
 * Retire a login session's unused login codes that were sent to another
 * address than `recipient`, for when the session's username changes. Best
 * effort: redemption checks the recipient regardless, so a failure here is
 * logged and ignored.
 */
export async function invalidateOtherLoginCodes(
  ctx: Context<any>,
  codes: CodesAdapter,
  tenantId: string,
  loginId: string,
  recipient: string,
): Promise<void> {
  try {
    const countryCode = ctx.get("countryCode") as CountryCode | undefined;
    const { codes: sessionCodes } = await codes.list(tenantId, {
      q: `login_id:${loginId}`,
      per_page: 100,
    });
    const now = new Date().toISOString();
    for (const code of sessionCodes) {
      if (
        code.login_id !== loginId ||
        code.code_type !== "otp" ||
        code.used_at ||
        code.expires_at < now ||
        isCodeRecipient(code, recipient, countryCode)
      ) {
        continue;
      }
      await codes.used(tenantId, code.code_id);
    }
  } catch (error) {
    console.error("Failed to invalidate earlier login codes:", error);
  }
}

export function preSignupCodeState(recipient: string): string {
  return codeRecipientState(recipient, undefined, {
    purpose: PRE_SIGNUP_CODE_PURPOSE,
  });
}

/**
 * Whether `stored` is an unexpired, unused pre-signup code minted for this
 * login session and sent to `email`.
 */
export function isPreSignupCodeFor(
  stored: Code | null | undefined,
  loginId: string,
  email: string | undefined,
): stored is Code {
  return (
    !!stored &&
    stored.login_id === loginId &&
    !stored.user_id &&
    !stored.used_at &&
    stored.expires_at >= new Date().toISOString() &&
    parseCodeState(stored).purpose === PRE_SIGNUP_CODE_PURPOSE &&
    isCodeRecipient(stored, email)
  );
}
