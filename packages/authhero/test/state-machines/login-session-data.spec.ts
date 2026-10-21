import { describe, it, expect, vi } from "vitest";
import {
  LoginSessionState,
  type LoginSession,
  type LoginSessionsAdapter,
} from "@authhero/adapter-interfaces";
import {
  createLoginSessionWithData,
  readLoginSessionData,
  updateLoginSessionData,
} from "../../src/state-machines/login-session-data";
import {
  LoginSessionEventType,
  transitionLoginSession,
  transitionLoginSessionFromEntity,
  canTransition,
} from "../../src/state-machines/login-session";
import {
  completeLoginSessionHook,
  completeLoginSessionContinuation,
} from "../../src/authentication-flows/common";
import type { Context } from "hono";

function setup(
  state = LoginSessionState.PENDING,
  data: Record<string, unknown> = {},
) {
  let session = {
    id: "login",
    state,
    state_data: JSON.stringify(data),
    authParams: {},
  } as LoginSession;
  const sessions: LoginSessionsAdapter = {
    get: vi.fn(async () => session),
    update: vi.fn(async (_tenant, _id, fields) => {
      session = { ...session, ...fields };
      return true;
    }),
    create: vi.fn(async (_tenant, fields) => {
      session = { ...session, ...fields };
      return session;
    }),
    remove: vi.fn(async () => true),
  };
  const ctx = {
    env: { data: { loginSessions: sessions } },
  } as unknown as Context;
  return { sessions, ctx, current: () => session };
}
const patch = (data: Parameters<typeof updateLoginSessionData>[3]["data"]) => ({
  type: LoginSessionEventType.UPDATE_CONTEXT as const,
  data,
});

describe("login session context ownership", () => {
  it("updates context without changing authentication state", async () => {
    const { sessions, current } = setup();
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ notice: "password_reset_success" }),
    );
    expect(current().state).toBe(LoginSessionState.PENDING);
    expect(readLoginSessionData(current().state_data)).toEqual({
      notice: "password_reset_success",
    });
  });

  it("reduces updates against stored data and preserves unknown legacy keys", async () => {
    const { sessions, current } = setup(LoginSessionState.PENDING, {
      legacy: { value: true },
      mfa_verified: true,
    });
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ notice: "password_reset_success" }),
    );
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ webauthn_challenge: "challenge" }),
    );
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ notice: undefined }),
    );
    expect(readLoginSessionData(current().state_data)).toEqual({
      legacy: { value: true },
      mfa_verified: true,
      webauthn_challenge: "challenge",
    });
  });

  it("persists context and accompanying session fields in one write", async () => {
    const { sessions, current } = setup(LoginSessionState.AWAITING_MFA);
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ mfa_verified: true }),
      { state: LoginSessionState.AUTHENTICATED },
    );
    expect(sessions.update).toHaveBeenCalledTimes(1);
    expect(current().state).toBe(LoginSessionState.AUTHENTICATED);
    expect(readLoginSessionData(current().state_data).mfa_verified).toBe(true);
  });

  it("writes an empty string when deleting the last key", async () => {
    const { sessions, current } = setup(LoginSessionState.PENDING, {
      notice: "password_reset_success",
    });
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ notice: undefined }),
    );
    expect(current().state_data).toBe("");
  });

  it("initializes new context through the machine", async () => {
    const { sessions } = setup();
    const result = await createLoginSessionWithData(
      sessions,
      "tenant",
      { authParams: {}, expires_at: new Date().toISOString() },
      { guardian_enrollment: true },
    );
    expect(readLoginSessionData(result.state_data)).toEqual({
      guardian_enrollment: true,
    });
  });

  it("clears only hook-owned keys on hook completion", async () => {
    const { ctx, current } = setup(LoginSessionState.AWAITING_HOOK, {
      hookId: "hook",
      form_values: { name: "Alice" },
      mfa_verified: true,
      notice: "password_reset_success",
    });
    await completeLoginSessionHook(ctx, "tenant", current());
    expect(current().state).toBe(LoginSessionState.AUTHENTICATED);
    expect(readLoginSessionData(current().state_data)).toEqual({
      mfa_verified: true,
      notice: "password_reset_success",
    });
  });

  it("removes the last continuation keys rather than passing undefined to an adapter", async () => {
    const { ctx, current } = setup(LoginSessionState.AWAITING_CONTINUATION, {
      continuationScope: ["account"],
      continuationReturnUrl: "/return",
    });
    expect(
      await completeLoginSessionContinuation(ctx, "tenant", current()),
    ).toBe("/return");
    expect(current().state_data).toBe("");
  });

  it.each([undefined, "", "not-json", "[]", "null", "1"])(
    "tolerates invalid legacy context: %s",
    (raw) => {
      expect(readLoginSessionData(raw)).toEqual({});
    },
  );

  it("recognizes targetless context events as valid transitions", () => {
    expect(
      canTransition(
        LoginSessionState.PENDING,
        LoginSessionEventType.UPDATE_CONTEXT,
      ),
    ).toBe(true);
    expect(
      canTransition(
        LoginSessionState.COMPLETED,
        LoginSessionEventType.UPDATE_CONTEXT,
      ),
    ).toBe(false);
  });

  it("rehydrates persisted context before reducing an entity event", () => {
    const { current } = setup(LoginSessionState.PENDING, {
      mfa_verified: true,
    });
    expect(
      transitionLoginSessionFromEntity(
        current(),
        patch({ notice: "password_reset_success" }),
      ).context.stateData,
    ).toEqual({ mfa_verified: true, notice: "password_reset_success" });
  });

  it("rejects context changes after finalization", async () => {
    const { sessions } = setup(LoginSessionState.COMPLETED);
    await expect(
      updateLoginSessionData(
        sessions,
        "tenant",
        "login",
        patch({ notice: "password_reset_success" }),
      ),
    ).rejects.toThrow("finalized");
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("does not write when dismissing an absent notice", async () => {
    const { sessions } = setup(LoginSessionState.PENDING, {
      mfa_verified: true,
    });
    await updateLoginSessionData(
      sessions,
      "tenant",
      "login",
      patch({ notice: undefined }),
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("does not mutate the supplied context during reduction", () => {
    const stateData = {
      notice: "password_reset_success" as const,
      mfa_verified: true,
    };
    const result = transitionLoginSession(
      LoginSessionState.PENDING,
      patch({ notice: undefined }),
      { stateData },
    );
    expect(stateData.notice).toBe("password_reset_success");
    expect(result.context.stateData).toEqual({ mfa_verified: true });
  });
});
