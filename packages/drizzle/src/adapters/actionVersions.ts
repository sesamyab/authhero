import { ActionVersionsAdapter } from "@authhero/adapter-interfaces";

/**
 * Stub action-versions adapter for the Drizzle backend.
 *
 * Mirrors the actions adapter — both are unimplemented in Drizzle. Any call
 * throws so the gap is obvious rather than silently returning empty results.
 */
export function createActionVersionsAdapter(): ActionVersionsAdapter {
  const notImplemented = (method: string): never => {
    throw new Error(
      `Action versions are not implemented in the Drizzle adapter (called ${method}). ` +
        "Use the Kysely adapter for tenants that require actions.",
    );
  };

  return {
    create: () => notImplemented("create"),
    get: () => notImplemented("get"),
    list: () => notImplemented("list"),
    removeForAction: () => notImplemented("removeForAction"),
  };
}
