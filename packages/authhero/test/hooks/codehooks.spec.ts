import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { CodeExecutor } from "@authhero/adapter-interfaces";
import { handleCodeHook } from "../../src/hooks/codehooks";
import { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";

type ExecuteCall = Parameters<CodeExecutor["execute"]>[0];

function makeRecordingExecutor() {
  const calls: ExecuteCall[] = [];
  const executor: CodeExecutor = {
    async execute(params) {
      calls.push(params);
      return {
        success: true,
        durationMs: 1,
        apiCalls: [],
        logs: [],
      };
    },
  };
  return { executor, calls };
}

async function runHandleCodeHook(
  testServer: Awaited<ReturnType<typeof getTestServer>>,
  hook: { code_id: string; hook_id: string },
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.post("/run", async (ctx) => {
    Object.assign(ctx.env, testServer.env);
    ctx.set("tenant_id", "tenantId");
    await handleCodeHook(
      ctx,
      testServer.env.data,
      hook,
      {
        ctx,
        user: { user_id: "email|userId", email: "foo@example.com" },
        request: {
          ip: "127.0.0.1",
          user_agent: "test",
          method: "POST",
          url: "http://localhost/run",
        },
        tenant: { id: "tenantId" },
      } as any,
      "post-user-login",
      {},
    );
    return ctx.json({ ok: true });
  });

  const res = await app.request(
    "/run",
    { method: "POST", headers: { "tenant-id": "tenantId" } },
    testServer.env,
  );
  expect(res.status).toBe(200);
}

describe("handleCodeHook code resolution", () => {
  it("loads code from data.actions when code_id matches an action", async () => {
    const { executor, calls } = makeRecordingExecutor();
    const server = await getTestServer({ codeExecutor: executor });

    const action = await server.env.data.actions.create("tenantId", {
      name: "Slack notify",
      code: "// from action",
      secrets: [{ name: "WEBHOOK_URL", value: "https://example.com/hook" }],
    });

    await runHandleCodeHook(server, {
      code_id: action.id,
      hook_id: "hk_action",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      code: "// from action",
      hookCodeId: action.id,
      triggerId: "post-user-login",
    });
    expect(calls[0]!.event).toMatchObject({
      secrets: { WEBHOOK_URL: "https://example.com/hook" },
    });
  });

  it("falls back to data.hookCode when no action exists for the code_id", async () => {
    const { executor, calls } = makeRecordingExecutor();
    const server = await getTestServer({ codeExecutor: executor });

    const hookCode = await server.env.data.hookCode.create("tenantId", {
      code: "// from hookCode",
      secrets: { LEGACY_KEY: "shh" },
    });

    await runHandleCodeHook(server, {
      code_id: hookCode.id,
      hook_id: "hk_legacy",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      code: "// from hookCode",
      hookCodeId: hookCode.id,
    });
    expect(calls[0]!.event).toMatchObject({
      secrets: { LEGACY_KEY: "shh" },
    });
  });

  it("does not invoke the executor when neither table has the code_id", async () => {
    const { executor, calls } = makeRecordingExecutor();
    const server = await getTestServer({ codeExecutor: executor });

    await runHandleCodeHook(server, {
      code_id: "act_does_not_exist",
      hook_id: "hk_missing",
    });

    expect(calls).toHaveLength(0);
  });
});
