import { describe, it, expect, vi } from "vitest";
import type { Session } from "@authhero/adapter-interfaces";
import {
  getSessionMfaCompletion,
  recordSessionMfa,
  sessionSatisfiesMfa,
} from "../../src/helpers/session-mfa";

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: "sid",
    user_id: "auth0|user",
    login_session_id: "lid",
    created_at: now,
    updated_at: now,
    authenticated_at: now,
    last_interaction_at: now,
    clients: ["clientId"],
    device: {
      last_ip: "",
      initial_ip: "",
      last_user_agent: "",
      initial_user_agent: "",
      initial_asn: "",
      last_asn: "",
    },
    ...overrides,
  };
}

describe("session MFA helpers", () => {
  it("reports no completion for a session without MFA entries", () => {
    expect(getSessionMfaCompletion(makeSession())).toBeUndefined();
    expect(
      getSessionMfaCompletion(
        makeSession({
          authentication: {
            methods: [{ name: "pwd", timestamp: new Date().toISOString() }],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns the latest MFA time and the distinct types used", () => {
    const completion = getSessionMfaCompletion(
      makeSession({
        authentication: {
          methods: [
            {
              name: "mfa",
              type: "totp",
              timestamp: "2026-11-01T10:00:00.000Z",
            },
            {
              name: "mfa",
              type: "phone",
              timestamp: "2026-11-02T10:00:00.000Z",
            },
            {
              name: "mfa",
              type: "totp",
              timestamp: "2026-11-01T12:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(completion).toEqual({
      completed_at: "2026-11-02T10:00:00.000Z",
      types: ["totp", "phone"],
    });
  });

  it("only lets a live session of the same user satisfy MFA", () => {
    const authentication = {
      methods: [
        { name: "mfa", type: "totp", timestamp: new Date().toISOString() },
      ],
    };
    expect(
      sessionSatisfiesMfa(makeSession({ authentication }), "auth0|user"),
    ).toBe(true);
    // Impersonation reuses the impersonator's session for another user.
    expect(
      sessionSatisfiesMfa(makeSession({ authentication }), "auth0|other"),
    ).toBe(false);
    expect(
      sessionSatisfiesMfa(
        makeSession({ authentication, revoked_at: new Date().toISOString() }),
        "auth0|user",
      ),
    ).toBe(false);
    expect(
      sessionSatisfiesMfa(
        makeSession({
          authentication,
          idle_expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
        "auth0|user",
      ),
    ).toBe(false);
    expect(sessionSatisfiesMfa(makeSession(), "auth0|user")).toBe(false);
  });

  it("records an MFA entry once per verification time", async () => {
    const update = vi.fn(async () => true);
    const sessions = { update };
    const timestamp = "2026-11-05T12:00:00.000Z";
    const existing = makeSession({
      authentication: { methods: [{ name: "mfa", type: "totp", timestamp }] },
    });

    await recordSessionMfa(sessions, "tenantId", existing, {
      type: "totp",
      timestamp,
    });
    expect(update).not.toHaveBeenCalled();

    await recordSessionMfa(sessions, "tenantId", makeSession(), {
      type: "phone",
      timestamp,
    });
    expect(update).toHaveBeenCalledWith("tenantId", "sid", {
      authentication: { methods: [{ name: "mfa", type: "phone", timestamp }] },
    });
  });
});
