import { DataAdapters, LoginSession } from "@authhero/adapter-interfaces";

/** Key under `state_data` holding a one-shot notice for the next screen. */
export const SESSION_NOTICE_STATE_KEY = "notice";

/**
 * Notices a flow can leave on the login session for the screen the user lands
 * on next. Stored as a code, never as text, so the screen translates it at
 * render time and a language switch still shows it in the right language.
 */
export type SessionNotice = "password_reset_success";

function parseStateData(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  } catch {
    return {};
  }
}

export function readSessionNotice(
  loginSession?: LoginSession | null,
): SessionNotice | undefined {
  const notice = parseStateData(loginSession?.state_data)[
    SESSION_NOTICE_STATE_KEY
  ];
  return notice === "password_reset_success" ? notice : undefined;
}

export async function setSessionNotice(
  data: DataAdapters,
  tenantId: string,
  loginSession: LoginSession,
  notice: SessionNotice,
): Promise<void> {
  await data.loginSessions.update(tenantId, loginSession.id, {
    state_data: JSON.stringify({
      ...parseStateData(loginSession.state_data),
      [SESSION_NOTICE_STATE_KEY]: notice,
    }),
  });
}

/**
 * Drops the notice once the user has moved past the screen it was meant for.
 * Written as "" when nothing else is left in `state_data`: adapters skip
 * `undefined` properties on update, so omitting the column would leave it be.
 */
export async function clearSessionNotice(
  data: DataAdapters,
  tenantId: string,
  loginSession: LoginSession,
): Promise<void> {
  const stateData = parseStateData(loginSession.state_data);
  if (!(SESSION_NOTICE_STATE_KEY in stateData)) return;

  delete stateData[SESSION_NOTICE_STATE_KEY];
  await data.loginSessions.update(tenantId, loginSession.id, {
    state_data:
      Object.keys(stateData).length > 0 ? JSON.stringify(stateData) : "",
  });
}
