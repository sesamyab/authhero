import declarations from "./codeHookApiDeclarations.generated.json";
import type { CodeHookApiByTrigger } from "./codeHookApiTypes";

/** Generated from the sandbox's TypeScript contract; no compiler needed at runtime. */
export const CODE_HOOK_API_TYPE_DECLARATIONS: Readonly<
  Record<keyof CodeHookApiByTrigger, string>
> = declarations;

export function getCodeHookApiTypeDeclarations(triggerId: string): string {
  const id = triggerId === "post-login" ? "post-user-login" : triggerId;
  if (!Object.hasOwn(CODE_HOOK_API_TYPE_DECLARATIONS, id))
    throw new Error(`Unsupported action trigger: ${triggerId}`);
  return CODE_HOOK_API_TYPE_DECLARATIONS[id as keyof CodeHookApiByTrigger];
}
