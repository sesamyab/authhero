import type { Context } from "hono";
import type { LoginSession } from "@authhero/adapter-interfaces";
import type { EnrichedClient } from "../../../helpers/client";
import type { Bindings, Variables } from "../../../types";
import generateOTP from "../../../utils/otp";
import { sendCode, sendLink } from "../../../emails";
import { OTP_EXPIRATION_TIME } from "../../../constants";
import type { ScreenContext, ScreenFactory, ScreenResult } from "./types";

/**
 * Create a one-time code bound to the login session and deliver it to the
 * user, either as a code or (for magic-link email connections) as a link.
 */
export async function sendLoginOtp(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
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
) {
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
}

/**
 * Re-send the login OTP (code or magic link) for the login session behind
 * `state`, to the username the identifier step stored on it.
 *
 * Only re-sends when a login OTP was issued for this session before. The
 * enumeration-safe stub path in the identifier screens shows the challenge
 * without issuing a code, and a resend must not start delivering to an
 * unknown address either.
 *
 * Returns false when the login session is gone or has no username.
 */
export async function resendLoginOtp(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
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
  const issued = codes.some(
    (code) => code.login_id === loginSession.id && code.code_type === "otp",
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
