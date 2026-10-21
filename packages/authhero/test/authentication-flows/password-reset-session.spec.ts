import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginSessionState } from "@authhero/adapter-interfaces";
import { requestPasswordReset } from "../../src/authentication-flows/password";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const sessions = {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const ctx = {
    env: { data: { loginSessions: sessions } },
  } as unknown as Parameters<typeof requestPasswordReset>[0];
  const client = {
    client_id: "client",
    tenant: { id: "tenant" },
  } as Parameters<typeof requestPasswordReset>[1];
  return {
    sessions,
    request: () =>
      requestPasswordReset(ctx, client, "alice@example.com", "login", "code"),
  };
}

describe("reset requests on finalized login sessions", () => {
  it.each([
    LoginSessionState.COMPLETED,
    LoginSessionState.FAILED,
    LoginSessionState.EXPIRED,
  ])("silently ignores a %s session before account lookup", async (state) => {
    const { sessions, request } = setup();
    sessions.get.mockResolvedValue({ id: "login", state });
    await expect(request()).resolves.toBeUndefined();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("silently handles finalization between the two session reads", async () => {
    const { sessions, request } = setup();
    sessions.get
      .mockResolvedValueOnce({ id: "login", state: LoginSessionState.PENDING })
      .mockResolvedValueOnce({
        id: "login",
        state: LoginSessionState.COMPLETED,
      });
    await expect(request()).resolves.toBeUndefined();
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated persistence failure", async () => {
    const { sessions, request } = setup();
    sessions.get
      .mockResolvedValueOnce({ id: "login", state: LoginSessionState.PENDING })
      .mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(request()).rejects.toThrow("storage unavailable");
  });
});
