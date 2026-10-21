import { describe, expect, it } from "vitest";
import { LoginSessionState } from "@authhero/adapter-interfaces";
import {
  canTransition,
  LoginSessionEventType,
  transitionLoginSession,
  type LoginSessionEvent,
} from "../../src/state-machines/login-session";
import {
  canCompletePasswordReset,
  transitionPasswordReset,
} from "../../src/state-machines/password-reset";

describe("password reset workflow", () => {
  it("cannot complete without a request", () => {
    expect(
      transitionPasswordReset(undefined, { type: "COMPLETE" }),
    ).toBeUndefined();
    expect(
      canTransition(
        LoginSessionState.PENDING,
        LoginSessionEventType.PASSWORD_RESET_COMPLETED,
      ),
    ).toBe(false);
  });

  it("does not accept reset workflow state through a generic context patch", () => {
    const result = transitionLoginSession(LoginSessionState.PENDING, {
      type: LoginSessionEventType.UPDATE_CONTEXT,
      data: {
        passwordReset: {
          state: "awaiting_code",
          username: "alice@example.com",
          requestId: "forged",
        },
      },
    } as unknown as LoginSessionEvent);
    expect(result.context.stateData?.passwordReset).toBeUndefined();
    expect(
      canTransition(
        result.state,
        LoginSessionEventType.PASSWORD_RESET_COMPLETED,
        result.context,
      ),
    ).toBe(false);
  });

  it.each(["code", "link"] as const)(
    "tracks a %s request independently of authentication",
    (method) => {
      const requested = transitionLoginSession(
        LoginSessionState.PENDING,
        {
          type: LoginSessionEventType.PASSWORD_RESET_REQUESTED,
          username: "alice@example.com",
          requestId: "request",
          method,
        },
        { stateData: { mfa_verified: true } },
      );
      expect(requested.state).toBe(LoginSessionState.PENDING);
      expect(requested.context.stateData?.passwordReset).toEqual({
        state: `awaiting_${method}`,
        username: "alice@example.com",
        requestId: "request",
      });
      expect(
        canCompletePasswordReset(
          requested.context.stateData?.passwordReset,
          method,
        ),
      ).toBe(true);
      expect(
        canCompletePasswordReset(
          requested.context.stateData?.passwordReset,
          method === "code" ? "link" : "code",
        ),
      ).toBe(false);
      const completed = transitionLoginSession(
        requested.state,
        {
          type: LoginSessionEventType.PASSWORD_RESET_COMPLETED,
          requestId: "request",
        },
        requested.context,
      );
      expect(completed.state).toBe(LoginSessionState.PENDING);
      expect(completed.context.stateData).toEqual({
        mfa_verified: true,
        passwordReset: {
          state: "completed",
          username: "alice@example.com",
          requestId: "request",
        },
        notice: "password_reset_success",
      });
      expect(
        canTransition(
          completed.state,
          LoginSessionEventType.PASSWORD_RESET_COMPLETED,
          completed.context,
        ),
      ).toBe(false);
    },
  );

  it("cannot complete a different request", () => {
    const result = transitionLoginSession(
      LoginSessionState.PENDING,
      {
        type: LoginSessionEventType.PASSWORD_RESET_COMPLETED,
        requestId: "old",
      },
      {
        stateData: {
          passwordReset: {
            state: "awaiting_code",
            username: "alice@example.com",
            requestId: "new",
          },
        },
      },
    );
    expect(result.context.stateData).toBeUndefined();
  });

  it("allows a fresh request after completion and clears the old notice", () => {
    const result = transitionLoginSession(
      LoginSessionState.PENDING,
      {
        type: LoginSessionEventType.PASSWORD_RESET_REQUESTED,
        username: "bob@example.com",
        requestId: "new",
        method: "link",
      },
      {
        stateData: {
          passwordReset: {
            state: "completed",
            username: "alice@example.com",
            requestId: "old",
          },
          notice: "password_reset_success",
        },
      },
    );
    expect(result.context.stateData?.passwordReset).toEqual({
      state: "awaiting_link",
      username: "bob@example.com",
      requestId: "new",
    });
    expect(result.context.stateData?.notice).toBeUndefined();
  });

  it.each([
    LoginSessionState.COMPLETED,
    LoginSessionState.FAILED,
    LoginSessionState.EXPIRED,
  ])("cannot request or complete a reset in a finalized %s login", (state) => {
    expect(
      canTransition(state, LoginSessionEventType.PASSWORD_RESET_REQUESTED),
    ).toBe(false);
    expect(
      canTransition(state, LoginSessionEventType.PASSWORD_RESET_COMPLETED, {
        stateData: {
          passwordReset: {
            state: "awaiting_code",
            username: "alice@example.com",
            requestId: "request",
          },
        },
      }),
    ).toBe(false);
  });
});
