/**
 * Shared helpers for account management screens
 */

import type { User, Session } from "@authhero/adapter-interfaces";
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
