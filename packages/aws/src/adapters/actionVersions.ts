import { ActionVersionsAdapter } from "@authhero/adapter-interfaces";

/**
 * Stub action-versions adapter for the DynamoDB backend.
 *
 * Mirrors the actions adapter — both are unimplemented in AWS. Any call
 * throws so the gap is obvious rather than silently returning empty results.
 */
export function createActionVersionsAdapter(): ActionVersionsAdapter {
  const notImplemented = (method: string): never => {
    throw new Error(
      `Action versions are not implemented in the AWS DynamoDB adapter (called ${method}). ` +
        "Use a SQL-backed adapter (kysely) for tenants that require actions.",
    );
  };

  return {
    create: () => notImplemented("create"),
    get: () => notImplemented("get"),
    list: () => notImplemented("list"),
    removeForAction: () => notImplemented("removeForAction"),
  };
}
