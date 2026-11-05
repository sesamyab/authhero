import type {
  Session,
  SessionAuthenticationMethod,
  SessionsAdapter,
} from "@authhero/adapter-interfaces";

/** `name` of the session authentication method recorded for a completed MFA. */
export const SESSION_MFA_METHOD_NAME = "mfa";

export interface SessionMfaCompletion {
  /** Latest time MFA was completed in this session (ISO 8601). */
  completed_at: string;
  /** Authentication method types used, oldest first (e.g. "totp", "phone"). */
  types: string[];
}

/**
 * The MFA this browser session has completed, or undefined when it never did
 * (including sessions from before MFA was recorded on the session, #1668).
 */
export function getSessionMfaCompletion(
  session: Pick<Session, "authentication">,
): SessionMfaCompletion | undefined {
  const mfaMethods = (session.authentication?.methods ?? []).filter(
    (method) =>
      method.name === SESSION_MFA_METHOD_NAME &&
      !Number.isNaN(Date.parse(method.timestamp)),
  );
  if (mfaMethods.length === 0) {
    return undefined;
  }

  let completedAt = mfaMethods[0]!.timestamp;
  for (const method of mfaMethods) {
    if (Date.parse(method.timestamp) > Date.parse(completedAt)) {
      completedAt = method.timestamp;
    }
  }

  const types: string[] = [];
  for (const method of mfaMethods) {
    if (method.type && !types.includes(method.type)) {
      types.push(method.type);
    }
  }

  return { completed_at: completedAt, types };
}

/**
 * Whether `session` satisfies the tenant's MFA requirement for `userId`.
 * Only a session that belongs to that same user counts, so a session reused
 * for impersonation never lends its MFA to the impersonated user.
 */
export function sessionSatisfiesMfa(
  session: Pick<
    Session,
    | "authentication"
    | "user_id"
    | "revoked_at"
    | "expires_at"
    | "idle_expires_at"
  >,
  userId: string,
): boolean {
  if (session.revoked_at || session.user_id !== userId) {
    return false;
  }
  const now = Date.now();
  if (session.expires_at && Date.parse(session.expires_at) < now) {
    return false;
  }
  if (session.idle_expires_at && Date.parse(session.idle_expires_at) < now) {
    return false;
  }
  return getSessionMfaCompletion(session) !== undefined;
}

/**
 * Append a completed MFA to the browser session. Idempotent for a given
 * `timestamp`, so re-entering the auth flow for the same login (e.g. after a
 * hook redirect) doesn't stack duplicate entries.
 */
export async function recordSessionMfa(
  sessions: Pick<SessionsAdapter, "update">,
  tenantId: string,
  session: Session,
  method: { type?: string; timestamp: string },
): Promise<void> {
  const methods = session.authentication?.methods ?? [];
  const alreadyRecorded = methods.some(
    (existing) =>
      existing.name === SESSION_MFA_METHOD_NAME &&
      existing.timestamp === method.timestamp,
  );
  if (alreadyRecorded) {
    return;
  }

  const entry: SessionAuthenticationMethod = {
    name: SESSION_MFA_METHOD_NAME,
    timestamp: method.timestamp,
    ...(method.type ? { type: method.type } : {}),
  };

  await sessions.update(tenantId, session.id, {
    authentication: { methods: [...methods, entry] },
  });
}
