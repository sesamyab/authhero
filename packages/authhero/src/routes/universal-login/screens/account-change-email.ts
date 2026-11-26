/**
 * Change email screens - the u2 equivalent of /u/account/change-email,
 * /u/account/change-email-verify and /u/account/change-email-confirmation.
 *
 * 1. account-change-email: the user enters a new address and a one-time code
 *    is emailed to it.
 * 2. account-change-email-verify: the user enters the code; the address is
 *    changed (and marked verified) on the user and its linked identities, and
 *    a confirmation with a continue link is shown.
 *
 * Both work from a signed-in session (`/u2/account`, `screen_hint=change-email`)
 * and mid-login, when a form hook redirects to change-email: the login session
 * then carries the `change-email` continuation scope and the user comes from
 * it instead of a session cookie, as on /u.
 *
 * Unlike /u, the new address is stored with the code rather than passed in the
 * URL, so the address that ends up on the account is the one the code was sent
 * to. Whether an address is taken is only revealed after the code for it has
 * been entered, i.e. to someone who controls that inbox.
 *
 * Corresponds to: /u2/account/change-email and /u2/account/change-email/verify
 */

import type {
  DataAdapters,
  FormNodeComponent,
  LoginSession,
  RateLimitDecision,
  Session,
  UiScreen,
  User,
} from "@authhero/adapter-interfaces";
import { LogTypes, escapeLuceneValue } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenDefinition, ScreenResult } from "./types";
import { getLoginPath } from "./types";
import { resolveAccountUser } from "./account-helpers";
import { createTranslation } from "../../../i18n";
import { escapeHtml } from "../sanitization-utils";
import { RedirectException } from "../../../errors/redirect-exception";
import { hasValidContinuationScope } from "../../../authentication-flows/common";
import { updateLoginSessionData } from "../../../state-machines/login-session-data";
import {
  LoginSessionEventType,
  readLoginSessionData,
} from "../../../state-machines/login-session";
import { sendCode } from "../../../emails";
import { logMessage } from "../../../helpers/logging";
import { OTP_EXPIRATION_TIME } from "../../../constants";
import generateOTP from "../../../utils/otp";
import { isValidEmail, normalizeEmail } from "../../../utils/email";

const CONTINUATION_SCOPE = "change-email";
const CHANGE_EMAIL_PURPOSE = "change_email";

type PostResult = Awaited<
  ReturnType<NonNullable<ScreenDefinition["handler"]["post"]>>
>;

function isRateLimitDecision(value: unknown): value is RateLimitDecision {
  return (
    typeof value === "object" &&
    value !== null &&
    "allowed" in value &&
    typeof (value as { allowed: unknown }).allowed === "boolean"
  );
}

/**
 * Every user matching `q`, page by page. The offset listing returns linked
 * identities as rows of their own, so a single page can be filled by the
 * user's own identities and hide another owner.
 */
export async function listAllUsers(
  users: DataAdapters["users"],
  tenantId: string,
  q: string,
  pageSize = 100,
): Promise<User[]> {
  const all: User[] = [];
  for (let page = 0; ; page++) {
    const result = await users.list(tenantId, {
      page,
      per_page: pageSize,
      include_totals: false,
      q,
    });
    all.push(...result.users);
    if (result.users.length < pageSize) return all;
  }
}

/** Whether a user outside this account (the user and its linked identities) has `email`. */
export async function isEmailTakenOutsideAccount(
  users: DataAdapters["users"],
  tenantId: string,
  email: string,
  userId: string,
  pageSize = 100,
): Promise<boolean> {
  const matches = await listAllUsers(
    users,
    tenantId,
    `email:${escapeLuceneValue(email)}`,
    pageSize,
  );
  return matches.some((u) => u.user_id !== userId && u.linked_to !== userId);
}

function maskEmail(email: string): string {
  return email.includes("@") ? email.replace(/(.{2})(.*)(@.*)/, "$1***$3") : "";
}

function getLanguage(uiLocales?: string) {
  return uiLocales?.split(" ")?.map((locale) => locale.split("-")[0])[0];
}

async function getLoginSession(
  context: ScreenContext,
): Promise<LoginSession | undefined> {
  const { ctx, tenant, state } = context;
  const loginSession = await ctx.env.data.loginSessions.get(tenant.id, state);
  return loginSession ?? undefined;
}

/**
 * The user whose email is being changed. Mid-login (a form hook sent the user
 * here) the login session's continuation scope authorizes the page and names
 * the user; otherwise a signed-in session cookie is required.
 */
export async function resolveChangeEmailUser(context: ScreenContext): Promise<{
  user: User;
  session: Session | null;
  loginSession: LoginSession;
  isContinuation: boolean;
}> {
  const { ctx, tenant, state } = context;
  const loginSession = await getLoginSession(context);
  if (!loginSession) {
    throw new RedirectException(
      `${await getLoginPath(context)}?state=${encodeURIComponent(state)}`,
    );
  }

  if (hasValidContinuationScope(loginSession, CONTINUATION_SCOPE)) {
    const user = loginSession.user_id
      ? await ctx.env.data.users.get(tenant.id, loginSession.user_id)
      : null;
    if (!user) {
      throw new RedirectException(
        `${await getLoginPath(context)}?state=${encodeURIComponent(state)}`,
      );
    }
    ctx.set("sessionAuth", {
      strategy: "session",
      user: {
        user_id: user.user_id,
        ...(user.name ? { name: user.name } : {}),
        ...(user.email ? { email: user.email } : {}),
      },
    });
    const session = loginSession.session_id
      ? await ctx.env.data.sessions.get(tenant.id, loginSession.session_id)
      : null;
    return { user, session, loginSession, isContinuation: true };
  }

  const { user, session } = await resolveAccountUser(context);
  return { user, session, loginSession, isContinuation: false };
}

/**
 * Where the user goes once the email is changed: back into the login flow
 * when a form hook sent them here, to the application when it asked for
 * `screen_hint=change-email`, and to the account page otherwise.
 */
function getContinueUrl(
  context: ScreenContext,
  loginSession: LoginSession,
  isContinuation: boolean,
): string {
  const { routePrefix = "/u2", state } = context;
  const accountUrl = `${routePrefix}/account?state=${encodeURIComponent(state)}`;

  if (isContinuation) {
    return (
      readLoginSessionData(loginSession.state_data).continuationReturnUrl ||
      accountUrl
    );
  }

  if (loginSession.authorization_url) {
    try {
      const authUrl = new URL(loginSession.authorization_url);
      if (authUrl.searchParams.get("screen_hint") === "change-email") {
        return loginSession.authParams.redirect_uri || accountUrl;
      }
    } catch {
      // Not a URL; fall back to the account page
    }
  }

  return accountUrl;
}

function accountLink(context: ScreenContext, text: string) {
  const { routePrefix = "/u2", state } = context;
  return {
    id: "back-to-account",
    text,
    href: `${routePrefix}/account?state=${encodeURIComponent(state)}`,
  };
}

// ---------------------------------------------------------------------------
// Step 1: enter the new address
// ---------------------------------------------------------------------------

export async function accountChangeEmailScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const {
    branding,
    state,
    errors,
    messages,
    prefill,
    routePrefix = "/u2",
  } = context;
  const { user, isContinuation } = await resolveChangeEmailUser(context);
  const { m } = createTranslation(
    "common",
    "account-change-email",
    context.language || "en",
    context.customText,
  );

  const components: FormNodeComponent[] = [];
  if (user.email) {
    components.push({
      id: "current-email",
      type: "RICH_TEXT",
      category: "BLOCK",
      visible: true,
      config: {
        content: `<p>${escapeHtml(m.currentEmailLabel())}: <strong>${escapeHtml(user.email)}</strong></p>`,
      },
      order: 0,
    });
  }
  components.push(
    {
      id: "email",
      type: "EMAIL",
      category: "FIELD",
      visible: true,
      label: m.emailLabel(),
      config: {
        placeholder: m.emailLabel(),
        default_value:
          typeof prefill?.new_email === "string" ? prefill.new_email : "",
      },
      required: true,
      order: 1,
      messages: errors?.email
        ? [{ text: errors.email, type: "error" as const }]
        : undefined,
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      visible: true,
      config: { text: m.buttonText() },
      order: 2,
    },
  );

  const screen: UiScreen = {
    name: "account-change-email",
    action: `${routePrefix}/account/change-email?state=${encodeURIComponent(state)}`,
    method: "POST",
    title: m.title(),
    description: m.description(),
    components,
    messages,
    // Mid-login there is no account page to go back to.
    links: isContinuation
      ? undefined
      : [accountLink(context, m.backToAccountText())],
  };

  return { screen, branding };
}

async function handleChangeEmailSubmit(
  context: ScreenContext,
  data: Record<string, unknown>,
): Promise<PostResult> {
  const { ctx, tenant, routePrefix = "/u2", state } = context;
  const { user, loginSession } = await resolveChangeEmailUser(context);
  const { m } = createTranslation(
    "common",
    "account-change-email",
    context.language || "en",
    context.customText,
  );

  const email =
    typeof data.email === "string" ? normalizeEmail(data.email) : "";
  const withError = async (text: string) => ({
    error: text,
    screen: await accountChangeEmailScreen({
      ...context,
      prefill: { ...context.prefill, new_email: email },
      errors: { email: text },
    }),
  });

  if (!email || !isValidEmail(email)) {
    return withError(m.invalidEmail());
  }

  let code = generateOTP();
  while (await ctx.env.data.codes.get(tenant.id, code, "email_verification")) {
    code = generateOTP();
  }

  try {
    await ctx.env.data.codes.create(tenant.id, {
      code_id: code,
      code_type: "email_verification",
      login_id: loginSession.id,
      user_id: user.user_id,
      expires_at: new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString(),
      state: JSON.stringify({ purpose: CHANGE_EMAIL_PURPOSE, email }),
    });

    await updateLoginSessionData(
      ctx.env.data.loginSessions,
      tenant.id,
      loginSession.id,
      {
        type: LoginSessionEventType.UPDATE_CONTEXT,
        data: { pending_email_change: { email } },
      },
    );

    await sendCode(ctx, {
      to: email,
      code,
      language: getLanguage(loginSession.authParams.ui_locales),
    });
  } catch (err) {
    logMessage(ctx, tenant.id, {
      type: LogTypes.FAILED_CHANGE_EMAIL,
      description: `Change email code could not be sent: ${err instanceof Error ? err.message : "Unknown error"}`,
      userId: user.user_id,
    });
    return withError(m.sendFailed());
  }

  logMessage(ctx, tenant.id, {
    type: LogTypes.CODE_SENT,
    description: `Change email verification code sent to ${email}`,
    userId: user.user_id,
  });

  return {
    redirect: `${routePrefix}/account/change-email/verify?state=${encodeURIComponent(state)}`,
  };
}

export const accountChangeEmailScreenDefinition: ScreenDefinition = {
  id: "account-change-email",
  name: "Change Email",
  description: "Enter a new email address and receive a code to confirm it",
  handler: {
    get: accountChangeEmailScreen,
    post: handleChangeEmailSubmit,
  },
};

// ---------------------------------------------------------------------------
// Step 2: enter the code
// ---------------------------------------------------------------------------

function verifyTranslation(context: ScreenContext) {
  return createTranslation(
    "common",
    "account-change-email-verify",
    context.language || "en",
    context.customText,
  ).m;
}

export async function accountChangeEmailVerifyScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const { branding, state, errors, messages, routePrefix = "/u2" } = context;
  const { loginSession } = await resolveChangeEmailUser(context);

  const pending = readLoginSessionData(
    loginSession.state_data,
  ).pending_email_change;
  if (!pending?.email) {
    // Nothing requested yet (or already done): start over.
    throw new RedirectException(
      `${routePrefix}/account/change-email?state=${encodeURIComponent(state)}`,
    );
  }

  const m = verifyTranslation(context);
  const screen: UiScreen = {
    name: "account-change-email-verify",
    action: `${routePrefix}/account/change-email/verify?state=${encodeURIComponent(state)}`,
    method: "POST",
    title: m.title(),
    description: m.description({
      email: `<strong>${escapeHtml(maskEmail(pending.email))}</strong>`,
    }),
    components: [
      {
        id: "code",
        type: "TEXT",
        category: "FIELD",
        visible: true,
        label: m.codeLabel(),
        config: {
          placeholder: m.codeLabel(),
          max_length: 6,
          input_mode: "numeric",
          autocomplete: "one-time-code",
        },
        required: true,
        order: 0,
        messages: errors?.code
          ? [{ text: errors.code, type: "error" as const }]
          : undefined,
      },
      {
        id: "submit",
        type: "NEXT_BUTTON",
        category: "BLOCK",
        visible: true,
        config: { text: m.buttonText() },
        order: 1,
      },
    ],
    messages,
    links: [
      {
        id: "change-email",
        text: m.backText(),
        href: `${routePrefix}/account/change-email?state=${encodeURIComponent(state)}`,
      },
    ],
  };

  return { screen, branding };
}

function changeEmailDoneScreen(
  context: ScreenContext,
  email: string,
  continueUrl: string,
): ScreenResult {
  const { branding, state, routePrefix = "/u2" } = context;
  const m = verifyTranslation(context);
  return {
    branding,
    screen: {
      name: "account-change-email-verify",
      action: `${routePrefix}/account/change-email/verify?state=${encodeURIComponent(state)}`,
      method: "GET",
      title: m.successTitle(),
      description: m.successDescription({
        email: `<strong>${escapeHtml(email)}</strong>`,
      }),
      components: [],
      links: [{ id: "continue", text: m.continueText(), href: continueUrl }],
    },
  };
}

async function handleChangeEmailVerifySubmit(
  context: ScreenContext,
  data: Record<string, unknown>,
): Promise<PostResult> {
  const { ctx, tenant } = context;
  const { user, loginSession, isContinuation } =
    await resolveChangeEmailUser(context);
  const m = verifyTranslation(context);

  const withError = async (text: string) => ({
    error: text,
    screen: await accountChangeEmailVerifyScreen({
      ...context,
      errors: { code: text },
    }),
  });
  const fail = async (text: string, description: string) => {
    logMessage(ctx, tenant.id, {
      type: LogTypes.FAILED_CHANGE_EMAIL,
      description,
      userId: user.user_id,
    });
    return withError(text);
  };

  const code = typeof data.code === "string" ? data.code.trim() : "";
  if (!code) {
    return withError(m.noCode());
  }

  // A 6-digit code is ~20 bits; throttle guesses per login session.
  if (ctx.env.data.rateLimit) {
    let decision: RateLimitDecision = { allowed: true };
    try {
      const result: unknown = await ctx.env.data.rateLimit.consume(
        "brute-force",
        `change-email:${tenant.id}:${loginSession.id}`,
      );
      if (isRateLimitDecision(result)) {
        decision = result;
      }
    } catch (error) {
      // Fail open: a misbehaving rate-limit adapter must not lock users out.
      console.error("Change email rate limit consume failed:", error);
    }
    if (!decision.allowed) {
      return fail(m.tooManyAttempts(), "Rate limit exceeded for change email");
    }
  }

  const stored = await ctx.env.data.codes.get(
    tenant.id,
    code,
    "email_verification",
  );
  let meta: { purpose?: unknown; email?: unknown } = {};
  try {
    meta = stored?.state ? JSON.parse(stored.state) : {};
  } catch {
    // Treated as the wrong purpose below
  }
  if (
    !stored ||
    stored.login_id !== loginSession.id ||
    stored.user_id !== user.user_id ||
    meta.purpose !== CHANGE_EMAIL_PURPOSE ||
    typeof meta.email !== "string"
  ) {
    return fail(m.invalidCode(), "Change email code invalid");
  }
  if (stored.used_at || stored.expires_at < new Date().toISOString()) {
    return fail(m.invalidCode(), "Change email code expired or used");
  }
  const email = meta.email;

  // Only the address currently awaiting confirmation can be applied: codes
  // from earlier requests in this session (for other addresses) are void.
  const pending = readLoginSessionData(
    loginSession.state_data,
  ).pending_email_change;
  if (pending?.email !== email) {
    return fail(m.invalidCode(), "Change email code is for another address");
  }

  // The address is taken when a user outside this account has it. The
  // user's own linked identities don't count; they are updated below.
  if (
    await isEmailTakenOutsideAccount(
      ctx.env.data.users,
      tenant.id,
      email,
      user.user_id,
    )
  ) {
    return fail(m.emailTaken(), "Change email address already taken");
  }

  // Claim the code before writing: `consume` is atomic, so of two concurrent
  // submissions of the same code only one runs the user-update hooks and
  // outbox events. The writes go through the hooked user adapter, which
  // commits each update in its own transaction, so they can't share one with
  // the claim; if one fails, the user requests a new code (as on /u).
  if (!(await ctx.env.data.codes.consume(tenant.id, code))) {
    return fail(m.invalidCode(), "Change email code already used");
  }

  await ctx.env.data.users.update(tenant.id, user.user_id, {
    email,
    email_verified: true,
  });

  // Keep linked identities on the same address, as /u does.
  const linkedUsers = await listAllUsers(
    ctx.env.data.users,
    tenant.id,
    `linked_to:${escapeLuceneValue(user.user_id)}`,
  );
  for (const linkedUser of linkedUsers) {
    await ctx.env.data.users.update(tenant.id, linkedUser.user_id, {
      email,
      email_verified: true,
    });
  }

  await updateLoginSessionData(
    ctx.env.data.loginSessions,
    tenant.id,
    loginSession.id,
    {
      type: LoginSessionEventType.UPDATE_CONTEXT,
      data: { pending_email_change: undefined },
    },
  );

  logMessage(ctx, tenant.id, {
    type: LogTypes.SUCCESS_CHANGE_EMAIL,
    description: `Email changed to ${email}`,
    userId: user.user_id,
  });

  return {
    screen: changeEmailDoneScreen(
      context,
      email,
      getContinueUrl(context, loginSession, isContinuation),
    ),
  };
}

export const accountChangeEmailVerifyScreenDefinition: ScreenDefinition = {
  id: "account-change-email-verify",
  name: "Change Email - Verify",
  description: "Enter the code sent to the new email address",
  handler: {
    get: accountChangeEmailVerifyScreen,
    post: handleChangeEmailVerifySubmit,
  },
};
