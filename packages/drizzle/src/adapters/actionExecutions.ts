import { ActionExecutionsAdapter } from "@authhero/adapter-interfaces";

/**
 * Stub action-executions adapter for the Drizzle backend.
 *
 * Action executions piggyback on the actions feature, which is not yet
 * implemented for Drizzle (see `actions.ts`). Throwing keeps the gap
 * obvious rather than silently dropping execution records.
 */
export function createActionExecutionsAdapter(): ActionExecutionsAdapter {
  const notImplemented = (method: string): never => {
    throw new Error(
      `Action executions are not implemented in the Drizzle adapter (called ${method}). ` +
        "Use the Kysely adapter for tenants that require actions.",
    );
  };

  return {
    create: () => notImplemented("create"),
    get: () => notImplemented("get"),
  };
}
