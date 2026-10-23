/**
 * Prompt partials on the login screens. Auth0 keys partials by prompt and
 * screen; the u2 login screens map to the prompts below, which is where a
 * tenant stores the HTML for them.
 */

import type { ScreenDefinition, ScreenContext, ScreenResult } from "./types";

const LOGIN_PARTIALS: Record<string, string> = {
  identifier: "login-id",
  "enter-password": "login-password",
  login: "login",
};

async function addLoginPartials(
  context: ScreenContext,
  result: ScreenResult,
): Promise<ScreenResult> {
  const prompt = LOGIN_PARTIALS[result.screen.name ?? ""];
  if (!prompt) return result;

  const stored = await context.ctx.env.data.promptPartials?.get(
    context.tenant.id,
    prompt,
  );
  const partials = stored?.[prompt];
  if (!partials) return result;

  return { ...result, screen: { ...result.screen, partials } };
}

/**
 * Add the stored partials to a login screen, including when a handler returns
 * it (or the next step) from a POST.
 */
export function withLoginPartials(
  definition: ScreenDefinition,
): ScreenDefinition {
  const { get, post } = definition.handler;
  return {
    ...definition,
    handler: {
      get: async (context) => addLoginPartials(context, await get(context)),
      post: post
        ? async (context, data) => {
            const result = await post(context, data);
            return "screen" in result
              ? {
                  ...result,
                  screen: await addLoginPartials(context, result.screen),
                }
              : result;
          }
        : undefined,
    },
  };
}
