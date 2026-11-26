import { describe, expect, it } from "vitest";
import {
  LoginSessionState,
  type LoginSession,
  type LoginSessionsAdapter,
} from "@authhero/adapter-interfaces";
import {
  readLoginSessionData,
  reserveLoginSessionCounter,
} from "../../src/state-machines/login-session-data";
import { getTestServer } from "../helpers/test-server";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * In-memory adapter that yields between every read and write, so concurrent
 * callers interleave the way parallel requests do against a real database.
 */
function slowAdapter(
  initial: Partial<LoginSession> = {},
  { cas = true }: { cas?: boolean } = {},
) {
  let row = {
    id: "login",
    state: LoginSessionState.PENDING,
    state_data: "",
    authParams: {},
    ...initial,
  } as LoginSession;
  const adapter: LoginSessionsAdapter = {
    get: async () => {
      await tick();
      return { ...row };
    },
    update: async (_tenant, _id, fields) => {
      await tick();
      row = { ...row, ...fields };
      return true;
    },
    create: async () => row,
    remove: async () => true,
  };
  if (cas) {
    adapter.updateIfStateDataUnchanged = async (
      _tenant,
      _id,
      expected,
      fields,
    ) => {
      await tick();
      // Check and write happen without yielding, like a conditional UPDATE.
      if ((row.state_data || undefined) !== expected) return false;
      row = { ...row, ...fields };
      return true;
    };
  }
  return { adapter, current: () => row };
}

describe("reserveLoginSessionCounter", () => {
  it("never reserves more than max slots under concurrent calls", async () => {
    const { adapter, current } = slowAdapter();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveLoginSessionCounter(adapter, "t", "login", "login_otp_sent", 5),
      ),
    );

    const reserved = results.filter((r) => r.status === "reserved");
    expect(reserved).toHaveLength(5);
    expect(readLoginSessionData(current().state_data).login_otp_sent).toBe(5);
  });

  it("is only best effort on adapters without updateIfStateDataUnchanged", async () => {
    const { adapter } = slowAdapter({}, { cas: false });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveLoginSessionCounter(adapter, "t", "login", "login_otp_sent", 5),
      ),
    );

    // Plain read/modify/write: every caller read 0 and passed.
    expect(results.filter((r) => r.status === "reserved").length).toBe(20);
  });

  it("keeps other context fields when incrementing", async () => {
    const { adapter, current } = slowAdapter({
      state_data: JSON.stringify({ mfa_sms_sent: 2, mfa_failed_attempts: 1 }),
    });

    const result = await reserveLoginSessionCounter(
      adapter,
      "t",
      "login",
      "mfa_sms_sent",
      5,
    );

    expect(result.status).toBe("reserved");
    expect(readLoginSessionData(current().state_data)).toMatchObject({
      mfa_sms_sent: 3,
      mfa_failed_attempts: 1,
    });
  });

  it("reports the limit without writing", async () => {
    const state_data = JSON.stringify({ login_otp_sent: 5 });
    const { adapter, current } = slowAdapter({ state_data });

    const result = await reserveLoginSessionCounter(
      adapter,
      "t",
      "login",
      "login_otp_sent",
      5,
    );

    expect(result.status).toBe("limit_reached");
    expect(current().state_data).toBe(state_data);
  });

  it("reports missing and finalized sessions", async () => {
    const missing: LoginSessionsAdapter = {
      ...slowAdapter().adapter,
      get: async () => null,
    };
    expect(
      (
        await reserveLoginSessionCounter(
          missing,
          "t",
          "login",
          "login_otp_sent",
          5,
        )
      ).status,
    ).toBe("not_found");

    const { adapter } = slowAdapter({ state: LoginSessionState.COMPLETED });
    expect(
      (
        await reserveLoginSessionCounter(
          adapter,
          "t",
          "login",
          "login_otp_sent",
          5,
        )
      ).status,
    ).toBe("finalized");
  });

  it("holds the cap against the kysely adapter under concurrent calls", async () => {
    const { env } = await getTestServer();
    const session = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      csrf_token: "csrf",
      authParams: { client_id: "clientId" },
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveLoginSessionCounter(
          env.data.loginSessions,
          "tenantId",
          session.id,
          "mfa_sms_sent",
          5,
        ),
      ),
    );

    expect(results.filter((r) => r.status === "reserved")).toHaveLength(5);
    const stored = await env.data.loginSessions.get("tenantId", session.id);
    expect(readLoginSessionData(stored?.state_data).mfa_sms_sent).toBe(5);
  });
});
