import { describe, expect, it } from "vitest";
import type { CodeExecutor } from "@authhero/adapter-interfaces";
import type { HookEvent } from "../../../src/types/Hooks";
import { getTestServer } from "../../helpers/test-server";

describe("u2 signup pre-user-registration request body", () => {
  it("passes only ulp-* fields to config and code hooks", async () => {
    const configEvents: HookEvent[] = [];
    const codeEvents: Record<string, unknown>[] = [];
    const codeExecutor: CodeExecutor = {
      async execute(params) {
        codeEvents.push(params.event);
        return { success: true, durationMs: 1, apiCalls: [], logs: [] };
      },
    };

    const { u2App, env } = await getTestServer({
      codeExecutor,
      hooks: {
        onExecutePreUserRegistration: async (event) => {
          configEvents.push(event);
        },
      },
    });

    const action = await env.data.actions.create("tenantId", {
      name: "read-signup-fields",
      code: "exports.onExecutePreUserRegistration = async () => {};",
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });

    const loginSession = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      csrf_token: "csrf",
      authParams: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
      },
    });

    const response = await u2App.request(
      `/screen/signup?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          data: {
            email: "custom-fields@example.com",
            password: "Password1!",
            re_password: "Password1!",
            "ulp-first-name": "Ada",
            unrelated: "must not be exposed",
          },
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(configEvents).toHaveLength(1);
    expect(configEvents[0]?.request.body).toEqual({
      "ulp-first-name": "Ada",
    });
    expect(codeEvents).toHaveLength(1);
    expect(
      (codeEvents[0]?.request as { body?: Record<string, unknown> }).body,
    ).toEqual({ "ulp-first-name": "Ada" });
  });
});
