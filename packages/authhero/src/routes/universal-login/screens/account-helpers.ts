/**
 * Shared helpers for account management screens
 */

import type { User, Session } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenFactory } from "./types";
import { getLoginPath } from "./types";
import { getAuthCookie } from "../../../utils/cookies";
import { RedirectException } from "../../../errors/redirect-exception";
import type { AccountActionOperation } from "../../../types/Hooks";
import {
  AccountActionDeniedError,
  runPreAccountAction,
} from "../../../hooks/pre-account-action";

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
 * Run the `pre-account-action` trigger for an operation the user is starting.
 * Returns the URL to send the user to when an Action redirects, `undefined`
 * to continue, and throws `AccountActionDeniedError` when an Action denies.
 */
export async function gateAccountOperation(
  context: ScreenContext,
  operation: AccountActionOperation,
  options: {
    user?: User | (() => Promise<User | undefined>);
    details?: Record<string, string>;
  } = {},
): Promise<string | undefined> {
  const decision = await runPreAccountAction(context.ctx, {
    tenantId: context.tenant.id,
    operation,
    client: context.client,
    user:
      options.user ?? (async () => (await resolveAccountUser(context)).user),
    details: options.details,
  });
  if (decision.type === "deny") {
    throw new AccountActionDeniedError(decision.reason);
  }
  return decision.type === "redirect" ? decision.url : undefined;
}

/**
 * Wrap a screen's GET factory so the trigger fires when the user opens the
 * screen. Only the definition's `get` is wrapped: POST handlers that re-render
 * the screen call the unwrapped factory, so the trigger fires once per entry.
 */
export function gatedScreen(
  operation: AccountActionOperation,
  factory: ScreenFactory,
  options: {
    details?: Record<string, string>;
    user?: (context: ScreenContext) => Promise<User | undefined>;
  } = {},
): ScreenFactory {
  const loadUser = options.user;
  return async (context) => {
    const url = await gateAccountOperation(context, operation, {
      details: options.details,
      user: loadUser ? () => loadUser(context) : undefined,
    });
    if (url) throw new RedirectException(url);
    return factory(context);
  };
}
