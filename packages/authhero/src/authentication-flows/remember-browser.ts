import { Context } from "hono";
import {
  encodeBase64Url,
  encodeHex,
  MFA_REMEMBER_BROWSER_MAX_LIFETIME_IN_DAYS,
  Tenant,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import {
  getMfaRememberBrowserTokens,
  serializeMfaRememberBrowserCookie,
} from "../utils/cookies";
import {
  MfaRequiredByAction,
  readLoginSessionData,
} from "../state-machines/login-session";
import { checkMfaRequired, tenantPolicyRequiresMfa } from "./mfa";

/**
 * "Remember this device" for MFA (#1670).
 *
 * After a successful MFA challenge the user can ask for the browser to be
 * remembered. The browser then gets an opaque random token in a cookie, and
 * only the token's SHA-256 is stored, as a `codes` row of type
 * `mfa_remember_browser` that carries the user id and expiry. A later login
 * of the same user from that browser skips the MFA challenge until the token
 * expires, the user's remembered browsers are invalidated, or the user no
 * longer has a confirmed MFA enrollment.
 *
 * A remembered browser satisfies MFA but is not MFA: no `amr` claim is
 * emitted and the browser session is not marked as having completed MFA.
 */

type RememberBrowserContext = Context<{
  Bindings: Bindings;
  Variables: Variables;
}>;

export const MFA_REMEMBER_BROWSER_DEFAULT_LIFETIME_IN_DAYS = 30;

/** `codes.code_type` of remembered browsers and of the invalidation marker. */
const CODE_TYPE = "mfa_remember_browser";

/** Users one browser can be remembered for at the same time. */
const MAX_TOKENS_PER_BROWSER = 5;

const TOKEN_BYTES = 32;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `code_id` of the row whose `created_at` is when the user's remembered
 * browsers were last invalidated. Token rows are keyed by a hex digest, so the
 * prefix can never collide with one.
 */
function invalidationCodeId(userId: string) {
  return `user:${userId}`;
}

async function hashToken(token: string): Promise<string> {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/** How long a remembered browser skips MFA for this tenant, in days. */
export function rememberBrowserLifetimeInDays(
  tenant: Pick<Tenant, "mfa">,
): number {
  return (
    tenant.mfa?.remember_browser_lifetime_in_days ??
    MFA_REMEMBER_BROWSER_DEFAULT_LIFETIME_IN_DAYS
  );
}

/**
 * Whether a remembered browser may stand in for MFA in this login. Every
 * source that requires MFA must allow it: the tenant policy through
 * `mfa.allow_remember_browser`, and a post-login action through
 * `api.multifactor.enable(provider, { allowRememberBrowser: true })`.
 */
export function isRememberBrowserAllowed(
  tenant: Pick<Tenant, "mfa">,
  actionRequest: MfaRequiredByAction | undefined,
): boolean {
  const policyRequiresMfa = tenantPolicyRequiresMfa(tenant.mfa?.policy);
  if (!policyRequiresMfa && !actionRequest) {
    return false;
  }
  if (policyRequiresMfa && tenant.mfa?.allow_remember_browser !== true) {
    return false;
  }
  if (actionRequest && !actionRequest.allow_remember_browser) {
    return false;
  }
  return true;
}

/** `isRememberBrowserAllowed` for the MFA a login session is going through. */
export function isRememberBrowserAllowedForLoginSession(
  tenant: Pick<Tenant, "mfa">,
  loginSession: { state_data?: string | null },
): boolean {
  return isRememberBrowserAllowed(
    tenant,
    readLoginSessionData(loginSession.state_data).mfa_required_by_action,
  );
}

/** The value of the "remember this device" checkbox in a screen POST. */
export function wantsRememberBrowser(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(wantsRememberBrowser);
  }
  // The widget posts "true"/"false"; a plain HTML form posts "on" when ticked.
  return value === true || value === "true" || value === "on";
}

/** Form field id of the "remember this device" checkbox. */
export const REMEMBER_BROWSER_FIELD = "remember_browser";

/**
 * Remember this browser for `userId`: store a new token and return the
 * Set-Cookie values that hand it to the browser. Tokens of other users the
 * browser is remembered for are kept; this user's older tokens and tokens that
 * no longer resolve are dropped.
 */
export async function rememberBrowser(
  ctx: RememberBrowserContext,
  params: {
    tenant: Pick<Tenant, "id" | "mfa">;
    userId: string;
    loginId?: string;
  },
): Promise<string[]> {
  const { tenant, userId } = params;
  const lifetimeMs = rememberBrowserLifetimeInDays(tenant) * DAY_MS;
  const token = generateToken();
  await ctx.env.data.codes.create(tenant.id, {
    code_id: await hashToken(token),
    code_type: CODE_TYPE,
    user_id: userId,
    login_id: params.loginId,
    expires_at: new Date(Date.now() + lifetimeMs).toISOString(),
  });

  const kept: string[] = [];
  for (const existing of getMfaRememberBrowserTokens(
    tenant.id,
    ctx.req.header("cookie"),
  )) {
    if (kept.length >= MAX_TOKENS_PER_BROWSER - 1) break;
    const code = await ctx.env.data.codes.get(
      tenant.id,
      await hashToken(existing),
      CODE_TYPE,
    );
    if (
      code &&
      code.user_id !== userId &&
      Date.parse(code.expires_at) > Date.now()
    ) {
      kept.push(existing);
    }
  }

  return serializeMfaRememberBrowserCookie(
    tenant.id,
    [token, ...kept],
    Math.floor(lifetimeMs / 1000),
    ctx.var.host,
  );
}

/**
 * Whether this browser is remembered for `userId`, so the MFA challenge can be
 * skipped. False unless remembering is allowed for this login (see
 * `isRememberBrowserAllowed`), the browser presents a live token of this user
 * issued after the user's last invalidation and within the tenant's current
 * lifetime, and the user still has a confirmed MFA enrollment.
 */
export async function isBrowserRememberedForMfa(
  ctx: RememberBrowserContext,
  params: {
    tenant: Pick<Tenant, "id" | "mfa">;
    userId: string;
    actionRequest?: MfaRequiredByAction;
  },
): Promise<boolean> {
  const { tenant, userId } = params;
  if (!isRememberBrowserAllowed(tenant, params.actionRequest)) {
    return false;
  }
  const tokens = getMfaRememberBrowserTokens(
    tenant.id,
    ctx.req.header("cookie"),
  );
  if (tokens.length === 0) {
    return false;
  }

  const invalidation = await ctx.env.data.codes.get(
    tenant.id,
    invalidationCodeId(userId),
    CODE_TYPE,
  );
  const invalidatedAt = invalidation
    ? Date.parse(invalidation.created_at)
    : undefined;
  const now = Date.now();
  const lifetimeMs = rememberBrowserLifetimeInDays(tenant) * DAY_MS;

  let remembered = false;
  for (const token of tokens) {
    const code = await ctx.env.data.codes.get(
      tenant.id,
      await hashToken(token),
      CODE_TYPE,
    );
    if (!code || code.user_id !== userId || code.used_at) continue;
    const createdAt = Date.parse(code.created_at);
    if (
      Number.isNaN(createdAt) ||
      Date.parse(code.expires_at) <= now ||
      // A shorter lifetime set after the token was issued applies to it too.
      createdAt + lifetimeMs <= now ||
      (invalidatedAt !== undefined && createdAt <= invalidatedAt)
    ) {
      continue;
    }
    remembered = true;
    break;
  }
  if (!remembered) {
    return false;
  }

  // A user without a confirmed enrollment (e.g. after an admin reset their
  // MFA) must enroll again; a remembered browser never skips enrollment.
  try {
    const mfaCheck = await checkMfaRequired(ctx, tenant.id, userId, {
      force: true,
    });
    return mfaCheck.required && mfaCheck.enrolled;
  } catch {
    return false;
  }
}

/**
 * Forget every browser remembered for `userId` (Auth0
 * `POST /users/{id}/multifactor/actions/invalidate-remember-browser`). Records
 * the time instead of deleting rows, because codes can't be listed by user in
 * every adapter. The marker outlives every token issued before it.
 */
export async function invalidateRememberedBrowsers(
  ctx: RememberBrowserContext,
  tenantId: string,
  userId: string,
): Promise<void> {
  const codeId = invalidationCodeId(userId);
  await ctx.env.data.codes.remove(tenantId, codeId);
  await ctx.env.data.codes.create(tenantId, {
    code_id: codeId,
    code_type: CODE_TYPE,
    user_id: userId,
    expires_at: new Date(
      Date.now() + MFA_REMEMBER_BROWSER_MAX_LIFETIME_IN_DAYS * DAY_MS,
    ).toISOString(),
  });
}
