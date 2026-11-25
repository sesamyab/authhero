/**
 * Invalid session screen - a passwordless link was opened somewhere it can't
 * complete (another browser or IP than the login started in, or the code had
 * already been used or expired).
 *
 * Corresponds to: /u2/invalid-session (u2 equivalent of /u/invalid-session)
 */

import type { UiScreen } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenResult, ScreenDefinition } from "./types";
import { createTranslation } from "../../../i18n";

/**
 * Where "Go back" sends the user: the client's redirect_uri with an
 * `invalid_session` error, as /u/invalid-session does. Only offered when the
 * login session carries the client's state, so the client can match it.
 */
async function getBackUrl(context: ScreenContext): Promise<string | undefined> {
  const { ctx, tenant, state } = context;
  const loginSession =
    ctx.var.loginSession?.id === state
      ? ctx.var.loginSession
      : await ctx.env.data.loginSessions.get(tenant.id, state);
  const authParams = loginSession?.authParams;
  if (!authParams?.redirect_uri || !authParams.state) {
    return undefined;
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(authParams.redirect_uri);
  } catch {
    return undefined;
  }
  redirectUrl.searchParams.set("state", authParams.state);
  redirectUrl.searchParams.set("error", "invalid_session");
  // Same value /u sends, so clients that read it keep working.
  redirectUrl.searchParams.set("error_description", authParams.username || "");
  return redirectUrl.href;
}

export async function invalidSessionScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const {
    branding,
    state,
    messages,
    customText,
    routePrefix = "/u2",
  } = context;

  const { m } = createTranslation(
    "common",
    "invalid-session",
    context.language || "en",
    customText,
  );

  const backUrl = await getBackUrl(context);

  const screen: UiScreen = {
    name: "invalid-session",
    action: `${routePrefix}/invalid-session?state=${encodeURIComponent(state)}`,
    method: "GET",
    title: m.title(),
    description: m.description(),
    components: [],
    messages,
    links: backUrl
      ? [{ id: "back", text: "", linkText: m.backText(), href: backUrl }]
      : undefined,
  };

  return { screen, branding };
}

export const invalidSessionScreenDefinition: ScreenDefinition = {
  id: "invalid-session",
  name: "Invalid Session",
  description: "Shown when a login link can't be completed in this session",
  handler: {
    get: invalidSessionScreen,
  },
};
