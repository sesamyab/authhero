import type { Context } from "hono";
import type {
  LoginSession,
  RateLimitDecision,
} from "@authhero/adapter-interfaces";
import type { EnrichedClient } from "../../../helpers/client";
import type { Bindings, Variables } from "../../../types";
import generateOTP from "../../../utils/otp";
import { sendCode, sendLink } from "../../../emails";
import { OTP_EXPIRATION_TIME } from "../../../constants";
import {
  codeRecipientState,
  isCodeRecipient,
} from "../../../helpers/code-recipient";
import type { ScreenContext, ScreenFactory, ScreenResult } from "./types";
import { reserveLoginSessionCounter } from "../../../state-machines/login-session-data";

type OtpContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Login OTP codes or magic links (identifier step plus resends) delivered per
 * login session. Further requests are accepted but nothing is sent.
 *
 * Reserved atomically (see reserveLoginSessionCounter), so concurrent requests
 * on one session cannot exceed it on adapters that implement
 * `updateIfStateDataUnchanged`. The optional per-recipient rate limit bounds
 * sends across sessions.
 */
export const LOGIN_OTP_MAX_SENDS = 5;

function isRateLimitDecision(value: unknown): value is RateLimitDecision {
  return (
    typeof value === "object" &&
    value !== null &&
    "allowed" in value &&
    typeof value.allowed === "boolean"
  );
}

/**
 * Count a login OTP delivery on the login session and consume the optional
 * per-recipient rate limit. Returns false when either limit is reached, or
 * when the session is already finalized; callers then skip delivery but
 * respond as usual, so the response does not reveal the limit or whether
 * the address exists. Counted before sending, so failed sends count too.
 */
export async function allowLoginOtpSend(
  ctx: OtpContext,
  {
    tenantId,
    loginSessionId,
    to,
  }: { tenantId: string; loginSessionId: string; to: string },
): Promise<boolean> {
  const { status } = await reserveLoginSessionCounter(
    ctx.env.data.loginSessions,
    tenantId,
    loginSessionId,
    "login_otp_sent",
    LOGIN_OTP_MAX_SENDS,
  );
  if (status !== "reserved") {
    if (status === "limit_reached" || status === "contended") {
      console.warn("Login OTP send limit reached for login session");
    }
    return false;
  }

  const rateLimit = ctx.env.data.rateLimit;
  if (rateLimit) {
    let allowed = true;
    try {
      const result: unknown = await rateLimit.consume(
        "brute-force",
        `login-otp-send:${tenantId}:${to.toLowerCase()}`,
      );
      if (isRateLimitDecision(result)) allowed = result.allowed;
    } catch (error) {
      // Fail open: a misbehaving rate-limit adapter must not block logins.
      console.error("Login OTP rate limit consume failed:", error);
    }
    if (!allowed) {
      console.warn("Login OTP send rate limit reached for recipient");
      return false;
    }
  }

  return true;
}

/**
 * Create a one-time code bound to the login session and to `to`, and deliver
 * it to the user, either as a code or (for magic-link email connections) as a link.
 *
 * Subject to the per-session send cap and per-recipient rate limit in
 * allowLoginOtpSend; returns false, without sending, when a limit is hit.
 */
export async function sendLoginOtp(
  ctx: OtpContext,
  {
    client,
    loginSession,
    to,
    magicLink,
  }: {
    client: EnrichedClient;
    loginSession: LoginSession;
    to: string;
    magicLink: boolean;
  },
): Promise<boolean> {
  if (
    !(await allowLoginOtpSend(ctx, {
      tenantId: client.tenant.id,
      loginSessionId: loginSession.id,
      to,
    }))
  ) {
    return false;
  }

  let code_id = generateOTP();
  let existingCode = await ctx.env.data.codes.get(
    client.tenant.id,
    code_id,
    "otp",
  );

  while (existingCode) {
    code_id = generateOTP();
    existingCode = await ctx.env.data.codes.get(
      client.tenant.id,
      code_id,
      "otp",
    );
  }

  await ctx.env.data.codes.create(client.tenant.id, {
    code_id,
    code_type: "otp",
    login_id: loginSession.id,
    expires_at: new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString(),
    redirect_uri: loginSession.authParams.redirect_uri,
    state: codeRecipientState(to, ctx.get("countryCode")),
  });

  // Extract language from ui_locales
  const language = loginSession.authParams?.ui_locales
    ?.split(" ")
    ?.map((locale: string) => locale.split("-")[0])[0];

  if (magicLink) {
    await sendLink(ctx, {
      to,
      code: code_id,
      authParams: loginSession.authParams,
      language,
    });
  } else {
    await sendCode(ctx, {
      to,
      code: code_id,
      language,
    });
  }
  return true;
}

/**
 * Re-send the login OTP (code or magic link) for the login session behind
 * `state`, to the username the identifier step stored on it.
 *
 * Only re-sends when a login OTP was issued for this session to the same
 * recipient before. The enumeration-safe stub path in the identifier screens
 * shows the challenge without issuing a code, and a resend must not start
 * delivering to an unknown address either, nor to a new address the session
 * switched to after a code went to an earlier one. Repeated resends are capped by allowLoginOtpSend;
 * past the cap the caller still shows the usual "code sent" message.
 *
 * Returns false when the login session is gone or has no username.
 */
export async function resendLoginOtp(
  ctx: OtpContext,
  {
    client,
    state,
    magicLink,
  }: {
    client: EnrichedClient;
    state: string;
    magicLink: boolean;
  },
): Promise<boolean> {
  const loginSession = await ctx.env.data.loginSessions.get(
    client.tenant.id,
    state,
  );
  const to = loginSession?.authParams?.username;
  if (!loginSession || !to) return false;

  const { codes } = await ctx.env.data.codes.list(client.tenant.id, {
    q: `login_id:${loginSession.id}`,
    per_page: 100,
  });
  const countryCode = ctx.get("countryCode");
  const issued = codes.some(
    (code) =>
      code.login_id === loginSession.id &&
      code.code_type === "otp" &&
      isCodeRecipient(code, to, countryCode),
  );
  if (!issued) return true;

  await sendLoginOtp(ctx, { client, loginSession, to, magicLink });
  return true;
}

/**
 * POST handler body for the RESEND_BUTTON on the login OTP screens
 * (email-otp-challenge, sms-otp-challenge, magic-link-sent): re-send and
 * re-render the screen with a success or error message.
 */
export async function loginOtpResendResult(
  context: ScreenContext,
  {
    render,
    magicLink,
    successText,
    failedText,
    expiredText,
  }: {
    render: ScreenFactory;
    magicLink: boolean;
    successText: string;
    failedText: string;
    expiredText: string;
  },
): Promise<{ screen: ScreenResult } | { error: string; screen: ScreenResult }> {
  let sent: boolean;
  try {
    sent = await resendLoginOtp(context.ctx, {
      client: context.client,
      state: context.state,
      magicLink,
    });
  } catch (err) {
    const safeErr =
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: "UnknownError" };
    console.error("Failed to resend login code:", safeErr);
    return {
      error: failedText,
      screen: await render({
        ...context,
        messages: [{ text: failedText, type: "error" }],
      }),
    };
  }

  if (!sent) {
    return {
      error: expiredText,
      screen: await render({
        ...context,
        messages: [{ text: expiredText, type: "error" }],
      }),
    };
  }

  return {
    screen: await render({
      ...context,
      errors: undefined,
      messages: [{ text: successText, type: "success" }],
    }),
  };
}
