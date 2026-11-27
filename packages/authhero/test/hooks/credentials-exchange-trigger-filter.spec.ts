import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { ActionExecutionInsert } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { parseJWT } from "../../src/utils/jwt";

// Token issuance must only run code hooks bound to `credentials-exchange`, not
// every enabled code hook on the tenant.

const POST_LOGIN_CODE = `
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim("from_post_login", true);
};
`;

const CREDENTIALS_EXCHANGE_CODE = `
exports.onExecuteCredentialsExchange = async (event, api) => {
  api.accessToken.setCustomClaim("from_credentials_exchange", true);
};
`;

async function setup(
  bindings: Array<{
    trigger_id: "post-user-login" | "pre-screen" | "credentials-exchange";
    code: string;
    metadata?: Record<string, unknown>;
  }>,
) {
  const executed: Array<{ triggerId: string; hookCodeId: string }> = [];
  const local = new LocalCodeExecutor();
  const server = await getTestServer({
    codeExecutor: {
      execute: (params) => {
        executed.push({
          triggerId: params.triggerId,
          hookCodeId: params.hookCodeId,
        });
        return local.execute(params);
      },
    },
  });
  const { env } = server;

  const actionIds: Record<string, string> = {};
  for (const binding of bindings) {
    const action = await env.data.actions.create("tenantId", {
      name: `${binding.trigger_id}-action`,
      code: binding.code,
    });
    actionIds[binding.trigger_id] = action.id;
    await env.data.hooks.create("tenantId", {
      trigger_id: binding.trigger_id,
      enabled: true,
      code_id: action.id,
      synchronous: true,
      ...(binding.metadata ? { metadata: binding.metadata } : {}),
    });
  }

  const stored: ActionExecutionInsert[] = [];
  const create = env.data.actionExecutions.create;
  env.data.actionExecutions.create = (tenantId, execution) => {
    stored.push(execution);
    return create(tenantId, execution);
  };

  const requestToken = () =>
    testClient(server.oauthApp, env).oauth.token.$post(
      {
        form: {
          grant_type: "client_credentials",
          client_id: "clientId",
          client_secret: "clientSecret",
          audience: "https://example.com",
        },
      },
      { headers: { "tenant-id": "tenantId" } },
    );

  return { executed, stored, actionIds, requestToken };
}

describe("credentials-exchange code hooks: trigger filter", () => {
  it("does not run actions bound to other triggers", async () => {
    const { executed, stored, actionIds, requestToken } = await setup([
      { trigger_id: "post-user-login", code: POST_LOGIN_CODE },
      { trigger_id: "credentials-exchange", code: CREDENTIALS_EXCHANGE_CODE },
    ]);

    const response = await requestToken();
    expect(response.status).toBe(200);

    expect(executed).toEqual([
      {
        triggerId: "credentials-exchange",
        hookCodeId: actionIds["credentials-exchange"],
      },
    ]);

    const body = (await response.json()) as { access_token: string };
    const payload = parseJWT(body.access_token)?.payload;
    expect(payload).toMatchObject({ from_credentials_exchange: true });
    expect(payload).not.toHaveProperty("from_post_login");

    const exchangeExecutions = stored.filter(
      (e) => e.trigger_id === "credentials-exchange",
    );
    expect(exchangeExecutions).toHaveLength(1);
    expect(exchangeExecutions[0]!.results).toHaveLength(1);
    expect(exchangeExecutions[0]!.results[0]!.error).toBeNull();
  });

  it("does not record an execution when only other triggers have actions", async () => {
    const { executed, stored, requestToken } = await setup([
      { trigger_id: "post-user-login", code: POST_LOGIN_CODE },
    ]);

    const response = await requestToken();
    expect(response.status).toBe(200);
    expect(executed).toEqual([]);
    expect(
      stored.filter((e) => e.trigger_id === "credentials-exchange"),
    ).toEqual([]);
  });

  it("a fail_closed binding on another trigger does not deny token requests", async () => {
    const { executed, requestToken } = await setup([
      {
        trigger_id: "post-user-login",
        code: POST_LOGIN_CODE,
        metadata: { fail_closed: true },
      },
      {
        trigger_id: "pre-screen",
        code: `exports.onExecutePreScreen = async () => {};`,
        metadata: { fail_closed: true },
      },
    ]);

    const response = await requestToken();
    expect(response.status).toBe(200);
    expect(executed).toEqual([]);
  });
});
