import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type {
  ActionExecutionInsert,
  CodeExecutor,
} from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { validateSignupEmail } from "../../src/hooks/validate-signup";
import { getEnrichedClient } from "../../src/helpers/client";
import type { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";

const TRIGGER = "validate-registration-username";

async function setup(executor: CodeExecutor | null = new LocalCodeExecutor()) {
  const executions: ActionExecutionInsert[] = [];
  const server = await getTestServer({
    ...(executor ? { codeExecutor: executor } : {}),
  });
  const { env, managementApp } = server;
  const token = await getAdminToken();
  const headers = {
    authorization: `Bearer ${token}`,
    "tenant-id": "tenantId",
    "content-type": "application/json",
  };
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.post("/validate", async (ctx) => {
    ctx.set("tenant_id", "tenantId");
    const client = await getEnrichedClient(env, "clientId", "tenantId");
    const result = await validateSignupEmail(
      ctx,
      client,
      env.data,
      "new@example.com",
      "Email",
    );
    const executionId = ctx.get("action_execution_id");
    if (executionId) {
      const execution = await env.data.actionExecutions.get(
        "tenantId",
        executionId,
      );
      if (execution) executions.push(execution);
    }
    return ctx.json(result);
  });
  const validate = async () =>
    (await app.request("/validate", { method: "POST" }, env)).json();
  async function createAction(name: string, body: string) {
    const response = await managementApp.request(
      "/actions/actions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          supported_triggers: [{ id: TRIGGER }],
          code: `exports.onExecuteValidateRegistrationUsername = async (event, api) => { ${body} };`,
          secrets: [{ name: "KEY", value: "validation-secret" }],
        }),
      },
      env,
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function bind(ids: string[]) {
    const response = await managementApp.request(
      `/actions/triggers/${TRIGGER}/bindings`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          bindings: ids.map((value) => ({ ref: { type: "action_id", value } })),
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const read = await managementApp.request(
      `/actions/triggers/${TRIGGER}/bindings`,
      { headers },
      env,
    );
    expect(read.status).toBe(200);
    expect(
      (await read.json()).bindings.map(
        (b: { action: { id: string } }) => b.action.id,
      ),
    ).toEqual(ids);
  }
  return { ...server, validate, createAction, bind, executions };
}

describe("registration username validation Actions", () => {
  it("binds through the API and passes the pre-user event and secrets", async () => {
    const s = await setup();
    const action = await s.createAction(
      "Inspect",
      `
      if (event.user.email !== "new@example.com" || event.user.connection !== "Email" ||
          event.user.user_id || event.tenant.id !== "tenantId" ||
          event.client.client_id !== "clientId" || event.request.method !== "POST" ||
          event.secrets.KEY !== "validation-secret") throw new Error("Wrong event");
      console.log("Validated");
    `,
    );
    await s.bind([action.id]);
    expect(await s.validate()).toEqual({ allowed: true });
    const { executions } = s;
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      trigger_id: TRIGGER,
      status: "final",
    });
  });

  it("runs in binding order and stops on denial, retaining the reason and logs", async () => {
    const s = await setup();
    const first = await s.createAction("First", 'console.log("first");');
    const deny = await s.createAction(
      "Deny",
      'console.log("denied"); api.access.deny("Invite required");',
    );
    const last = await s.createAction(
      "Last",
      'throw new Error("Must not run");',
    );
    await s.bind([first.id, deny.id, last.id]);
    expect(await s.validate()).toEqual({
      allowed: false,
      reason: "Invite required",
    });
    const { executions } = s;
    expect(executions[0]).toMatchObject({ status: "canceled" });
    expect(executions[0].results.map((r) => r.action_name)).toEqual([
      "First",
      "Deny",
    ]);
    expect(executions[0].logs).toContainEqual({
      action_name: "Deny",
      lines: [{ level: "log", message: "denied" }],
    });
    expect(executions[0].results[1].error).toMatchObject({
      id: "access_denied",
      msg: "Invite required",
    });
  });

  it.each(["throws", "missing executor"])(
    "blocks signup when the Action %s",
    async (failure) => {
      const s = await setup(
        failure === "missing executor" ? null : new LocalCodeExecutor(),
      );
      const action = await s.createAction(
        "Broken",
        'throw new Error("Private failure");',
      );
      await s.bind([action.id]);
      expect(await s.validate()).toEqual({
        allowed: false,
        reason: `${TRIGGER} Action failed`,
      });
      const { executions } = s;
      expect(executions[0].results[0].error).toBeTruthy();
    },
  );

  it("accepts direct hook bindings and skips disabled Actions", async () => {
    const s = await setup();
    const action = await s.createAction(
      "Disabled",
      'api.access.deny("Must not run");',
    );
    const response = await s.managementApp.request(
      "/hooks",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await getAdminToken()}`,
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          trigger_id: TRIGGER,
          code_id: action.id,
          enabled: false,
        }),
      },
      s.env,
    );
    expect(response.status).toBe(201);
    expect(await s.validate()).toEqual({ allowed: true });
    const hook = await response.json();
    await s.env.data.hooks.update("tenantId", hook.hook_id, { enabled: true });
    expect(await s.validate()).toEqual({
      allowed: false,
      reason: "Must not run",
    });
  });

  it("blocks real signup before a user is created", async () => {
    const s = await setup();
    const action = await s.createAction(
      "Invite only",
      'api.access.deny("Invite required");',
    );
    await s.bind([action.id]);
    const response = await s.oauthApp.request(
      "/dbconnections/signup",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "blocked@example.com",
          password: "Test12345!",
          connection: "Username-Password-Authentication",
          client_id: "clientId",
        }),
      },
      s.env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invite required");
    const { users } = await s.env.data.users.list("tenantId", {
      q: 'email:"blocked@example.com"',
    });
    expect(users).toHaveLength(0);
  });
});
