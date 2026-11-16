/**
 * The "remember this device" option on the MFA challenge screens (#1670).
 * See authentication-flows/remember-browser.ts for what remembering does.
 */

import type {
  FormNodeComponent,
  LoginSession,
} from "@authhero/adapter-interfaces";
import type { EnrichedClient } from "../../../helpers/client";
import type { ScreenContext } from "./types";
import {
  isRememberBrowserAllowedForLoginSession,
  REMEMBER_BROWSER_FIELD,
  rememberBrowser,
  rememberBrowserLifetimeInDays,
  wantsRememberBrowser,
} from "../../../authentication-flows/remember-browser";

/**
 * The checkbox, or undefined when remembering isn't allowed for the MFA this
 * login is going through. `label` receives the lifetime in days.
 */
export async function rememberBrowserComponent(
  context: ScreenContext,
  label: (days: number) => string,
  order: number,
): Promise<FormNodeComponent | undefined> {
  const loginSession = await context.ctx.env.data.loginSessions.get(
    context.client.tenant.id,
    context.state,
  );
  if (
    !loginSession ||
    !isRememberBrowserAllowedForLoginSession(
      context.client.tenant,
      loginSession,
    )
  ) {
    return undefined;
  }
  return {
    id: REMEMBER_BROWSER_FIELD,
    type: "BOOLEAN",
    category: "FIELD",
    visible: true,
    label: label(rememberBrowserLifetimeInDays(context.client.tenant)),
    config: { default_value: false },
    required: false,
    order,
  };
}

/**
 * Set-Cookie values that remember the browser, when the user ticked the box
 * and remembering is allowed. Best-effort: a failure only means the user is
 * asked for MFA again next time, so it never fails the login.
 */
export async function rememberBrowserCookies(
  ctx: ScreenContext["ctx"],
  client: EnrichedClient,
  loginSession: LoginSession,
  userId: string,
  data: Record<string, unknown>,
): Promise<string[]> {
  if (
    !wantsRememberBrowser(data[REMEMBER_BROWSER_FIELD]) ||
    !isRememberBrowserAllowedForLoginSession(client.tenant, loginSession)
  ) {
    return [];
  }
  try {
    return await rememberBrowser(ctx, {
      tenant: client.tenant,
      userId,
      loginId: loginSession.id,
    });
  } catch (err) {
    console.error("Failed to remember the browser for MFA", err);
    return [];
  }
}

/**
 * The POST result for a finished MFA challenge: the auth flow's response plus
 * the remember-browser cookies, if any.
 */
export function withRememberBrowserCookies(
  result: Response,
  rememberCookies: string[],
): { redirect: string; cookies: string[] } | { response: Response } {
  const location = result.headers.get("location");
  const cookies = [
    ...(result.headers.getSetCookie?.() || []),
    ...rememberCookies,
  ];
  if (location) {
    return { redirect: location, cookies };
  }
  for (const cookie of rememberCookies) {
    result.headers.append("set-cookie", cookie);
  }
  return { response: result };
}
