import { describe, expect, it } from "vitest";
import type {
  ActionExecutionInsert,
  CodeExecutor,
} from "@authhero/adapter-interfaces";
import type { HookEvent } from "../../../src/types/Hooks";
import { getTestServer } from "../../helpers/test-server";
import { getSignupPrefill } from "../../../src/routes/universal-login/screens/signup";
import { LocalCodeExecutor } from "../../../src/hooks/code-executor/local";

type ScreenMessage = { text: string; type: string };
type ScreenComponent = {
  id: string;
  config?: Record<string, unknown>;
};
type ScreenBody = {
  screen: { messages?: ScreenMessage[]; components: ScreenComponent[] };
};

async function seedSignupSession(
  env: Awaited<ReturnType<typeof getTestServer>>["env"],
) {
  return env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
    },
  });
}

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

    const loginSession = await seedSignupSession(env);

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

  it("shows config-hook validation errors on the HTML signup screen", async () => {
    const { u2App, env } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (_event, api) => {
          api.validation.error("missing_name", "Please enter your name");
        },
      },
    });
    const loginSession = await seedSignupSession(env);

    const response = await u2App.request(
      `/signup?state=${encodeURIComponent(loginSession.id)}`,
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: "validation-error@example.com",
          password: "Password1!",
          re_password: "Password1!",
          "ulp-first-name": "Ada",
        }).toString(),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Please enter your name");
    expect(body).toContain("validation-error@example.com");

    const { users } = await env.data.users.list("tenantId");
    expect(
      users.find((user) => user.email === "validation-error@example.com"),
    ).toBeUndefined();
  });

  it("shows code-hook validation errors in the JSON screen API and records a canceled execution", async () => {
    let createdExecution: ActionExecutionInsert | undefined;
    const { u2App, env } = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
      wrapDataAdapter: (data) => ({
        ...data,
        actionExecutions: {
          ...data.actionExecutions,
          create: async (tenantId, execution) => {
            createdExecution = execution;
            return data.actionExecutions.create(tenantId, execution);
          },
        },
      }),
    });

    const action = await env.data.actions.create("tenantId", {
      name: "validate-signup-fields",
      code: `
exports.onExecutePreUserRegistration = async (_event, api) => {
  api.validation.error("missing_name", "Please enter your name");
};
`,
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });
    const loginSession = await seedSignupSession(env);

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
            email: "code-validation-error@example.com",
            password: "Password1!",
            re_password: "Password1!",
            "ulp-first-name": "Ada",
          },
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ScreenBody;
    expect(body.screen.messages).toEqual([
      { text: "Please enter your name", type: "error" },
    ]);
    expect(
      body.screen.components.find((component) => component.id === "email")
        ?.config?.default_value,
    ).toBe("code-validation-error@example.com");
    expect(createdExecution).toMatchObject({
      trigger_id: "pre-user-registration",
      status: "canceled",
      results: [
        {
          action_name: action.id,
          error: { id: "missing_name", msg: "Please enter your name" },
        },
      ],
    });

    const { users } = await env.data.users.list("tenantId");
    expect(
      users.find((user) => user.email === "code-validation-error@example.com"),
    ).toBeUndefined();
  });

  it("preserves only email and string ulp-* values for a signup re-render", () => {
    expect(
      getSignupPrefill("prefill@example.com", {
        "ulp-first-name": "Ada",
        "ulp-age": 37,
        unrelated: "must not be retained",
        password: "must not be retained",
      }),
    ).toEqual({
      email: "prefill@example.com",
      "ulp-first-name": "Ada",
    });
  });
});
