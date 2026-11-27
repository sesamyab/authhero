/**
 * Shared helpers for account management screens
 */

import type { LoginSession, User, Session } from "@authhero/adapter-interfaces";
import { hasValidContinuationScope } from "../../../authentication-flows/common";
import { readLoginSessionData } from "../../../state-machines/login-session";
import type { ScreenContext } from "./types";
import { getLoginPath } from "./types";
import { getAuthCookie } from "../../../utils/cookies";
import { RedirectException } from "../../../errors/redirect-exception";

/**
 * Resolve the authenticated user from the session cookie.
 * Used by all account screens that need the current user.
 */
export async function resolveAccountUser(
  context: ScreenContext,
): Promise<{ user: User; session: Session }> {
  const { ctx, tenant, state } = context;

  const loginPath = await getLoginPath(context);

  // Get session from cookie
  const authCookie = getAuthCookie(tenant.id, ctx.req.header("cookie"));
  const session = authCookie
    ? await ctx.env.data.sessions.get(tenant.id, authCookie)
    : null;

  // If no valid session, redirect to login
  if (!session || session.revoked_at) {
    throw new RedirectException(
      `${loginPath}?state=${encodeURIComponent(state)}`,
    );
  }

  // Get the current user
  const user = await ctx.env.data.users.get(tenant.id, session.user_id);

  if (!user) {
    throw new RedirectException(
      `${loginPath}?state=${encodeURIComponent(state)}`,
    );
  }

  // Keep the verified caller separate from the management API's admin context.
  // Snapshot it before mutations so deletion and email changes cannot erase it.
  ctx.set("sessionAuth", {
    strategy: "session",
    user: {
      user_id: user.user_id,
      ...(user.name ? { name: user.name } : {}),
      ...(user.email ? { email: user.email } : {}),
    },
  });

  return { user, session };
}

/**
 * Resolve the account user either mid-login or from a session cookie.
 *
 * When a form hook redirects to an account page mid-login, the login session
 * is AWAITING_CONTINUATION with a scope naming that page (`account`,
 * `change-email`). That scope authorizes the page and names the user, so no
 * session cookie is needed. The first of `scopes` the login session carries is
 * returned as `continuationScope`; without one, a signed-in session cookie is
 * required as on every other account page.
 */
export async function resolveAccountUserOrContinuation(
  context: ScreenContext,
  scopes: readonly string[],
): Promise<{
  user: User;
  session: Session | null;
  loginSession: LoginSession;
  continuationScope?: string;
}> {
  const { ctx, tenant, state } = context;
  const loginSession = await ctx.env.data.loginSessions.get(tenant.id, state);
  if (!loginSession) {
    throw new RedirectException(
      `${await getLoginPath(context)}?state=${encodeURIComponent(state)}`,
    );
  }

  const continuationScope = scopes.find((scope) =>
    hasValidContinuationScope(loginSession, scope),
  );
  if (continuationScope) {
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
    return { user, session, loginSession, continuationScope };
  }

  const { user, session } = await resolveAccountUser(context);
  return { user, session, loginSession };
}

/**
 * Where "continue" sends a user who reached an account page mid-login: the
 * return URL stored when the continuation started (`/u2/continue?state=…`).
 */
export function getContinuationReturnUrl(
  loginSession: LoginSession,
): string | undefined {
  return readLoginSessionData(loginSession.state_data).continuationReturnUrl;
}
