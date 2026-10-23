/**
 * Prompt partials on the login screens. Auth0 keys partials by prompt and
 * screen; each login screen reads the one stored under its own prompt name
 * (`login-id`, `login-password`, `login`), like the signup screen does.
 */

import type { UiScreen } from "@authhero/adapter-interfaces";
import type { ScreenContext } from "./types";

export async function getLoginPartials(
  context: ScreenContext,
  prompt: "login-id" | "login-password" | "login",
): Promise<UiScreen["partials"]> {
  const stored = await context.ctx.env.data.promptPartials?.get(
    context.tenant.id,
    prompt,
  );
  return stored?.[prompt];
}
