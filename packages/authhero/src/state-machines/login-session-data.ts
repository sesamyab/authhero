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
  {
    type:
      | LoginSessionEventType.UPDATE_CONTEXT
      | LoginSessionEventType.PASSWORD_RESET_REQUESTED
      | LoginSessionEventType.PASSWORD_RESET_COMPLETED;
  }
>;

/** A terminal session cannot accept further context events. */
export class FinalizedLoginSessionError extends Error {
  constructor(id: string) {
    super(`Cannot update context of finalized login session ${id}`);
    this.name = "FinalizedLoginSessionError";
  }
}

/** Completed, failed and expired sessions accept no further context updates. */
export function isFinalizedLoginSession(
  session: Pick<LoginSession, "state">,
): boolean {
  return [
    LoginSessionState.COMPLETED,
    LoginSessionState.FAILED,
    LoginSessionState.EXPIRED,
  ].includes(session.state as LoginSessionState);
}

function serialize(data: LoginSessionData): string {
  const json = JSON.stringify(data);
  // Adapters skip undefined; clearing the last key must write an empty string.
  return json === "{}" ? "" : json;
}

/**
 * Sole persistence boundary for session context updates. Always reduce against
 * the latest stored context, never a caller's stale session snapshot. Optional
 * session fields (e.g. MFA state) are persisted in the same adapter update.
 * This is read/modify/write, not a cross-request atomic compare-and-swap;
 * use reserveLoginSessionCounter for counters that must hold a hard cap.
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
  if (isFinalizedLoginSession(current))
    throw new FinalizedLoginSessionError(id);
  const { context } = transitionLoginSession(
    current.state || LoginSessionState.PENDING,
    event,
    { stateData: readLoginSessionData(current.state_data) },
  );
  if (!context.stateData) {
    throw new Error(
      `Invalid context event ${event.type} for finalized or unrequested login session ${id}`,
    );
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

/** Per-session send counters that reserveLoginSessionCounter can cap. */
export type LoginSessionCounter = "login_otp_sent" | "mfa_sms_sent";

export type LoginSessionCounterStatus =
  /** The counter was incremented; the caller owns one slot. */
  | "reserved"
  /** The counter is already at `max`; nothing was written. */
  | "limit_reached"
  | "not_found"
  | "finalized"
  /** Every compare-and-swap attempt lost to a concurrent write. */
  | "contended";

export interface LoginSessionCounterReservation {
  status: LoginSessionCounterStatus;
  /** The session as last read (before the increment), when it exists. */
  session?: LoginSession;
}

/**
 * Upper bound on compare-and-swap rounds. Each lost round means some other
 * write landed, and once the counter reaches its (small) max every request
 * sees "limit_reached", so contention for a cap resolves well within this.
 */
const COUNTER_CAS_ATTEMPTS = 10;

/**
 * Atomically reserve one slot of a per-session counter capped at `max`.
 *
 * The increment is written with the adapter's `updateIfStateDataUnchanged`,
 * which only applies while `state_data` still equals what was read; a lost
 * race re-reads and retries. Because the counter only grows, concurrent
 * requests can never reserve more than `max` slots in total. Adapters without
 * that method fall back to a plain update (best effort, not atomic).
 */
export async function reserveLoginSessionCounter(
  sessions: LoginSessionsAdapter,
  tenantId: string,
  id: string,
  counter: LoginSessionCounter,
  max: number,
): Promise<LoginSessionCounterReservation> {
  for (let attempt = 0; attempt < COUNTER_CAS_ATTEMPTS; attempt++) {
    const current = await sessions.get(tenantId, id);
    if (!current) return { status: "not_found" };
    if (isFinalizedLoginSession(current))
      return { status: "finalized", session: current };

    const stateData = readLoginSessionData(current.state_data);
    const count = stateData[counter] ?? 0;
    if (count >= max) return { status: "limit_reached", session: current };

    const { context } = transitionLoginSession(
      current.state || LoginSessionState.PENDING,
      {
        type: LoginSessionEventType.UPDATE_CONTEXT,
        data: { [counter]: count + 1 },
      },
      { stateData },
    );
    if (!context.stateData) return { status: "finalized", session: current };
    const next = { state_data: serialize(context.stateData) };

    if (!sessions.updateIfStateDataUnchanged) {
      await sessions.update(tenantId, id, next);
      return { status: "reserved", session: current };
    }
    if (
      await sessions.updateIfStateDataUnchanged(
        tenantId,
        id,
        current.state_data || undefined,
        next,
      )
    ) {
      return { status: "reserved", session: current };
    }
  }
  return { status: "contended" };
}

/** Initialize context through the same machine reducer before inserting it. */
export function createLoginSessionWithData(
  sessions: LoginSessionsAdapter,
  tenantId: string,
  fields: Omit<LoginSessionInsert, "state_data">,
  data: Omit<LoginSessionData, "passwordReset">,
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
