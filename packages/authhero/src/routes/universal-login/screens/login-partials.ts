/**
 * Prompt partials on the login screens. Auth0 keys partials by prompt and
 * screen; each login screen reads the one stored under its own prompt name
 * (`login-id`, `login-password`, `login`), like the signup screen does.
 */

import type { PromptPartials, UiScreen } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenDefinition, ScreenResult } from "./types";
import { getPartialsTargetForScreen } from "../screen-prompt-map";

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

/**
 * Attach the tenant's prompt partials to a screen that doesn't read them
 * itself. A screen that already set `partials` is left alone, and a screen
 * without stored partials is returned untouched, so tenants that have not
 * configured partials see exactly what they saw before.
 */
export async function attachPromptPartials(
  context: ScreenContext,
  screenId: string,
  result: ScreenResult,
): Promise<ScreenResult> {
  const target = getPartialsTargetForScreen(screenId);
  if (!target || result.screen.partials) return result;

  let stored: PromptPartials | null | undefined;
  try {
    stored = await context.ctx.env.data.promptPartials?.get(
      context.tenant.id,
      target.prompt,
    );
  } catch (err) {
    // Partials are an enhancement: never take the login screen down with them.
    console.error("Failed to load prompt partials:", err);
    return result;
  }
  const partials = stored?.[target.key];
  if (!partials || Object.keys(partials).length === 0) return result;
  return { ...result, screen: { ...result.screen, partials } };
}

export function withPromptPartials(
  screenId: string,
  definition: ScreenDefinition,
): ScreenDefinition {
  const { get, post } = definition.handler;
  return {
    ...definition,
    handler: {
      get: async (context) =>
        attachPromptPartials(context, screenId, await get(context)),
      ...(post
        ? {
            post: async (context, data) => {
              const result = await post(context, data);
              if ("screen" in result) {
                return {
                  ...result,
                  screen: await attachPromptPartials(
                    context,
                    screenId,
                    result.screen,
                  ),
                };
              }
              return result;
            },
          }
        : {}),
    },
  };
}
