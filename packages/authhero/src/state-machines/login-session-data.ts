import type {
  LoginSession,
  LoginSessionInsert,
  LoginSessionsAdapter,
} from "@authhero/adapter-interfaces";
import {
  LoginSessionEventType,
  readLoginSessionData,
  transitionLoginSession,
  type LoginSessionData,
  type LoginSessionEvent,
} from "./login-session";
import { LoginSessionState } from "@authhero/adapter-interfaces";

export { readLoginSessionData } from "./login-session";

export type LoginSessionDataEvent = Extract<
  LoginSessionEvent,
  { type: LoginSessionEventType.UPDATE_CONTEXT }
>;

function serialize(data: LoginSessionData): string {
  const json = JSON.stringify(data);
  // Adapters skip undefined; clearing the last key must write an empty string.
  return json === "{}" ? "" : json;
}

/**
 * Sole persistence boundary for session context updates. Always reduce against
 * the latest stored context, never a caller's stale session snapshot. Optional
 * session fields (e.g. MFA state) are persisted in the same adapter update.
 * This is read/modify/write, not a cross-request atomic compare-and-swap.
 */
export async function updateLoginSessionData(
  sessions: LoginSessionsAdapter,
  tenantId: string,
  id: string,
  event: LoginSessionDataEvent,
  fields: Omit<Partial<LoginSession>, "state_data"> = {},
): Promise<boolean> {
  const current = await sessions.get(tenantId, id);
  if (!current) throw new Error(`Login session ${id} not found`);
  const { context } = transitionLoginSession(
    current.state || LoginSessionState.PENDING,
    event,
    { stateData: readLoginSessionData(current.state_data) },
  );
  if (!context.stateData) {
    throw new Error(`Cannot update context of finalized login session ${id}`);
  }
  const stateData = serialize(context.stateData);
  if (
    stateData === (current.state_data || "") &&
    Object.keys(fields).length === 0
  ) {
    return true;
  }
  return sessions.update(tenantId, id, { ...fields, state_data: stateData });
}

/** Initialize context through the same machine reducer before inserting it. */
export function createLoginSessionWithData(
  sessions: LoginSessionsAdapter,
  tenantId: string,
  fields: Omit<LoginSessionInsert, "state_data">,
  data: LoginSessionData,
): Promise<LoginSession> {
  const { context } = transitionLoginSession(LoginSessionState.PENDING, {
    type: LoginSessionEventType.UPDATE_CONTEXT,
    data,
  });
  return sessions.create(tenantId, {
    ...fields,
    state_data: serialize(context.stateData ?? {}),
  });
}
