import { describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import {
  getCodeHookApiTypeDeclarations,
  type ActionCodeGenerator,
} from "@authhero/adapter-interfaces";
import { createToken, getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

const TENANT = "tenantId";
const code =
  "exports.onExecutePostLogin = async (event, api) => { api.idToken.setCustomClaim('role', 'reader'); };";
const headers = { "tenant-id": TENANT };

function generator(source = code): ActionCodeGenerator {
  return {
    models: ["glm", "deepseek", "qwen"],
    generate: vi.fn(async () => ({ code: source })),
  };
}

describe("action generation and verification", () => {
  it("uses the configured adapter without saving or deploying generated drafts", async () => {
    const actionCodeGenerator = generator();
    const deploy = vi.fn();
    const { managementApp, env } = await getTestServer({
      actionCodeGenerator,
      codeExecutor: {
        deploy,
        execute: vi.fn(),
      },
    });
    const client = testClient(managementApp, env);
    const options = {
      headers: { authorization: `Bearer ${await getAdminToken()}` },
    };
    const capabilities = await client.actions.actions.generation.$get(
      { header: headers },
      options,
    );
    expect(await capabilities.json()).toEqual({
      models: ["glm", "deepseek", "qwen"],
      verification_required: true,
    });
    const before = await env.data.actions.list(TENANT, {});
    const response = await client.actions.actions.generate.$post(
      {
        header: headers,
        json: {
          model: "qwen",
          prompt: "Add a role claim",
          trigger_id: "post-login",
        },
      },
      options,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code,
      verification: { valid: true, errors: [] },
    });
    expect(actionCodeGenerator.generate).toHaveBeenCalledWith({
      model: "qwen",
      prompt: "Add a role claim",
      triggerId: "post-login",
      tenantId: TENANT,
      apiTypes: getCodeHookApiTypeDeclarations("post-login"),
    });
    expect(await env.data.actions.list(TENANT, {})).toEqual(before);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("enforces verification on create, patch and rollback before persistence or deploy", async () => {
    const deploy = vi.fn();
    const { managementApp, env } = await getTestServer({
      actionCodeGenerator: generator(),
      codeExecutor: { deploy, execute: vi.fn() },
    });
    const client = testClient(managementApp, env);
    const options = {
      headers: { authorization: `Bearer ${await getAdminToken()}` },
    };
    const invalid = await client.actions.actions.$post(
      {
        header: headers,
        json: {
          name: "invalid",
          code: "// invalid",
          supported_triggers: [{ id: "post-login" }],
        },
      },
      options,
    );
    expect(invalid.status).toBe(400);
    const invalidFallback = await client.actions.actions.$post(
      {
        header: headers,
        json: {
          name: "invalid fallback",
          code: "// invalid",
          inherit: true,
          supported_triggers: [{ id: "post-login" }],
        },
      },
      options,
    );
    expect(invalidFallback.status).toBe(400);
    expect(deploy).not.toHaveBeenCalled();
    const created = await client.actions.actions.$post(
      {
        header: headers,
        json: {
          name: "valid",
          code,
          supported_triggers: [{ id: "post-login" }],
        },
      },
      options,
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    deploy.mockClear();
    const patched = await client.actions.actions[":id"].$patch(
      {
        header: headers,
        param: { id },
        json: { code: "// edited after verification" },
      },
      options,
    );
    expect(patched.status).toBe(400);
    const changedTrigger = await client.actions.actions[":id"].$patch(
      {
        header: headers,
        param: { id },
        json: { supported_triggers: [{ id: "pre-user-registration" }] },
      },
      options,
    );
    expect(changedTrigger.status).toBe(400);
    expect((await env.data.actions.get(TENANT, id))?.code).toBe(code);
    const oldVersion = await env.data.actionVersions.create(TENANT, {
      action_id: id,
      code: "// legacy invalid",
      supported_triggers: [{ id: "post-login" }],
    });
    const rollback = await client.actions.actions[":actionId"].versions[
      ":id"
    ].deploy.$post(
      { header: headers, param: { actionId: id, id: oldVersion.id } },
      options,
    );
    expect(rollback.status).toBe(400);
    expect(deploy).not.toHaveBeenCalled();
    expect((await env.data.actions.get(TENANT, id))?.code).toBe(code);

    // Imported versions may omit supported_triggers; fall back to the action's.
    const triggerlessVersion = await env.data.actionVersions.create(TENANT, {
      action_id: id,
      code,
    });
    const triggerlessRollback = await client.actions.actions[
      ":actionId"
    ].versions[":id"].deploy.$post(
      { header: headers, param: { actionId: id, id: triggerlessVersion.id } },
      options,
    );
    expect(triggerlessRollback.status).toBe(200);
    expect(deploy).toHaveBeenCalledWith(id, code);
  });

  it("verifies drafts without a generator or executor and reports failures", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const options = {
      headers: { authorization: `Bearer ${await getAdminToken()}` },
    };
    const response = await client.actions.actions.verify.$post(
      {
        header: headers,
        json: {
          code: "// missing handler",
          supported_triggers: [{ id: "post-login" }],
        },
      },
      options,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: false });
    await expect(
      client.actions.actions.generate.$post(
        {
          header: headers,
          json: { prompt: "Generate", model: "glm", trigger_id: "post-login" },
        },
        options,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("requires write access, validates model/trigger/prompt and never forwards secrets", async () => {
    const actionCodeGenerator = generator();
    const { managementApp, env } = await getTestServer({ actionCodeGenerator });
    const client = testClient(managementApp, env);
    const json = {
      prompt: "Add a claim",
      model: "deepseek" as const,
      trigger_id: "post-login",
    };
    const reader = {
      headers: {
        authorization: `Bearer ${await createToken({ tenant_id: TENANT, permissions: ["read:actions"] })}`,
      },
    };
    expect(
      (
        await client.actions.actions.generate.$post(
          { header: headers, json },
          reader,
        )
      ).status,
    ).toBe(403);
    const writer = {
      headers: {
        authorization: `Bearer ${await createToken({ tenant_id: TENANT, permissions: ["update:actions"] })}`,
      },
    };
    expect(
      (
        await client.actions.actions.generate.$post(
          { header: headers, json },
          writer,
        )
      ).status,
    ).toBe(200);
    for (const invalid of [
      { ...json, prompt: " " },
      { ...json, trigger_id: "unknown" },
      { ...json, prompt: "x".repeat(10_001) },
    ]) {
      expect(
        (
          await client.actions.actions.generate.$post(
            { header: headers, json: invalid },
            writer,
          )
        ).status,
      ).toBe(400);
    }
    expect(actionCodeGenerator.generate).toHaveBeenCalledTimes(1);
  });

  it("returns failed verification for an invalid draft and hides adapter errors", async () => {
    const actionCodeGenerator = generator("// invalid source");
    const { managementApp, env } = await getTestServer({ actionCodeGenerator });
    const client = testClient(managementApp, env);
    const options = {
      headers: { authorization: `Bearer ${await getAdminToken()}` },
    };
    const request = {
      header: headers,
      json: {
        prompt: "Generate",
        model: "glm" as const,
        trigger_id: "post-login",
      },
    };
    const response = await client.actions.actions.generate.$post(
      request,
      options,
    );
    expect(await response.json()).toMatchObject({
      verification: { valid: false },
    });
    vi.mocked(actionCodeGenerator.generate).mockRejectedValue(
      new Error("secret-upstream-token"),
    );
    await expect(
      client.actions.actions.generate.$post(request, options),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.not.stringContaining("secret-upstream-token"),
    });
  });
});
