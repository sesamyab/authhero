import { describe, it, expect } from "vitest";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";

describe("LocalCodeExecutor console capture", () => {
  it("captures console.log/warn/error and replays api calls", async () => {
    const exec = new LocalCodeExecutor();
    const code = `
exports.onExecutePostLogin = async (event, api) => {
  console.log("hello", { user_id: event.user.user_id });
  console.warn("warning here");
  console.error("an error");
  api.idToken.setCustomClaim("test", "ok");
};
`;
    const result = await exec.execute({
      code,
      triggerId: "post-user-login",
      event: { user: { user_id: "u_123" } },
    });

    expect(result.success).toBe(true);
    expect(result.apiCalls).toEqual([
      { method: "idToken.setCustomClaim", args: ["test", "ok"] },
    ]);
    expect(result.logs).toEqual([
      { level: "log", message: 'hello {"user_id":"u_123"}' },
      { level: "warn", message: "warning here" },
      { level: "error", message: "an error" },
    ]);
  });

  it("captures logs even when user code throws", async () => {
    const exec = new LocalCodeExecutor();
    const code = `
exports.onExecutePostLogin = async () => {
  console.log("before throw");
  throw new Error("boom");
};
`;
    const result = await exec.execute({
      code,
      triggerId: "post-user-login",
      event: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.logs).toEqual([{ level: "log", message: "before throw" }]);
  });
});
