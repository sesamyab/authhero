import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type {
  CodeExecutor,
  ActionExecutionInsert,
} from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import { CodeHookDestination } from "../../src/helpers/outbox-destinations/code-hooks";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { buildPostHookEvent } from "../../src/helpers/hook-events";
import type { Bindings, Variables } from "../../src/types";

const TENANT = "tenantId";
const USER = "email|lifecycle";
const handlerNames = {
  "pre-user-update": "onExecutePreUserUpdate",
  "post-user-update": "onExecutePostUserUpdate",
  "pre-user-deletion": "onExecutePreUserDeletion",
  "post-user-deletion": "onExecutePostUserDeletion",
} as const;
type Trigger = keyof typeof handlerNames;

async function setup(
  options: { executor?: CodeExecutor | null; outbox?: boolean } = {},
) {
  const executor =
    options.executor === undefined ? new LocalCodeExecutor() : options.executor;
  const executions: ActionExecutionInsert[] = [];
  const server = await getTestServer({
    wrapDataAdapter: (data) => ({
      ...data,
      actionExecutions: {
        ...data.actionExecutions,
        create: async (tenant, execution) => {
          executions.push(execution);
          return data.actionExecutions.create(tenant, execution);
        },
      },
    }),
    ...(executor ? { codeExecutor: executor } : {}),
    outbox: options.outbox,
  });
  const { env, managementApp } = server;
  await env.data.users.create(TENANT, {
    user_id: USER,
    email: "lifecycle@example.com",
    name: "Before",
    connection: "email",
    provider: "email",
    is_social: false,
    registration_completed_at: new Date().toISOString(),
  });
  const token = await getAdminToken();
  const request = (
    method: string,
    path = `/users/${encodeURIComponent(USER)}`,
    body?: unknown,
  ) =>
    managementApp.request(
      path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": TENANT,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  async function bind(
    trigger: Trigger,
    body = "",
    priority = 0,
    enabled = true,
  ) {
    const action = await env.data.actions.create(TENANT, {
      name: `${trigger}-${priority}`,
      supported_triggers: [{ id: trigger }],
      code: `exports.${handlerNames[trigger]} = async (event, api) => { ${body} };`,
      secrets: [{ name: "KEY", value: "action-secret" }],
    });
    const hook = await env.data.hooks.create(TENANT, {
      code_id: action.id,
      trigger_id: trigger,
      enabled,
      priority,
    });
    return { action, hook };
  }
  return { ...server, request, bind, executions };
}

for (const trigger of ["pre-user-update", "pre-user-deletion"] as const) {
  describe(trigger, () => {
    const mutate = (s: Awaited<ReturnType<typeof setup>>) =>
      trigger === "pre-user-update"
        ? s.request("PATCH", undefined, { name: "After" })
        : s.request("DELETE");

    it("times out a hanging executor and records failure before any write", async () => {
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const local = new LocalCodeExecutor();
      const s = await setup({
        executor: {
          execute(params) {
            signalStarted();
            return local.execute(params);
          },
        },
      });
      await s.bind(trigger, "await new Promise(() => {});");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = mutate(s);
        // Authentication uses real async crypto. Wait for the executor itself
        // to start before advancing its deadline, independent of runner load.
        await started;
        await vi.advanceTimersByTimeAsync(5001);
        expect((await response).status).toBe(400);
        expect((await s.env.data.users.get(TENANT, USER))?.name).toBe("Before");
        expect(s.executions[0].results[0].error?.msg).toContain(
          "timed out after 5000ms",
        );
        expect(s.executions[0].status).toBe("partial");
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs enabled Actions in priority order before the write, with secrets and sanitized state", async () => {
      const local = new LocalCodeExecutor();
      const calls: Parameters<CodeExecutor["execute"]>[0][] = [];
      const s = await setup({
        executor: {
          async execute(params) {
            expect((await s.env.data.users.get(TENANT, USER))?.name).toBe(
              "Before",
            );
            calls.push(params);
            return local.execute(params);
          },
        },
      });
      await s.bind(trigger, 'console.log("last")', 1);
      await s.bind(trigger, 'console.log("first")', 10);
      await s.bind(trigger, 'throw new Error("disabled")', 100, false);
      const response = await mutate(s);
      expect(response.status).toBe(trigger === "pre-user-update" ? 200 : 204);
      expect(calls.map((c) => c.code.includes('"first"'))).toEqual([
        true,
        false,
      ]);
      expect(calls[0].event).toMatchObject({
        user_id: USER,
        tenant: { id: TENANT },
        secrets: { KEY: "action-secret" },
        user: { name: "Before" },
      });
      expect(calls[0].event).not.toHaveProperty("ctx");
      expect(calls[0].event.user).not.toHaveProperty(
        "registration_completed_at",
      );
      if (trigger === "pre-user-update") {
        expect(calls[0].event).toMatchObject({
          previous_user: { name: "Before" },
          updates: { name: "After" },
        });
      }
    });

    it("denies before any writes or identity unlinking, stops later Actions, and records cancellation", async () => {
      const s = await setup();
      await s.env.data.users.create(TENANT, {
        user_id: "google|secondary",
        email: "secondary@example.com",
        connection: "google",
        provider: "google",
        is_social: true,
        linked_to: USER,
      });
      await s.bind(
        trigger,
        'console.log("policy denied"); api.access.deny("Protected account");',
        10,
      );
      await s.bind(trigger, 'throw new Error("should not run")', 1);
      const response = await mutate(s);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Protected account");
      expect((await s.env.data.users.get(TENANT, USER))?.name).toBe("Before");
      expect(
        (await s.env.data.users.get(TENANT, "google|secondary"))?.linked_to,
      ).toBe(USER);
      const execution = s.executions[0];
      expect(execution?.status).toBe("canceled");
      expect(execution?.results).toHaveLength(1);
      expect(execution?.logs?.[0].lines[0].message).toBe("policy denied");
    });

    it.each(["throw", "timeout", "missing-code", "missing-executor"])(
      "fails closed on %s",
      async (failure) => {
        const executor =
          failure === "missing-executor"
            ? null
            : failure === "timeout"
              ? {
                  execute: vi.fn<CodeExecutor["execute"]>().mockResolvedValue({
                    success: false,
                    error: "Execution timed out",
                    durationMs: 5000,
                    apiCalls: [],
                  }),
                }
              : new LocalCodeExecutor();
        const s = await setup({ executor });
        const { action } = await s.bind(
          trigger,
          'throw new Error("policy unavailable")',
        );
        if (failure === "missing-code")
          await s.env.data.actions.remove(TENANT, action.id);
        const response = await mutate(s);
        expect(response.status).toBe(400);
        expect((await s.env.data.users.get(TENANT, USER))?.name).toBe("Before");
        expect(s.executions).toHaveLength(1);
        expect(s.executions[0].status).toBe("partial");
      },
    );
  });
}

for (const trigger of ["post-user-update", "post-user-deletion"] as const) {
  describe(trigger, () => {
    it.each([true, false])(
      "runs only after commit (outbox=%s), preserving snapshots and idempotency",
      async (outbox) => {
        const local = new LocalCodeExecutor();
        const calls: Parameters<CodeExecutor["execute"]>[0][] = [];
        const s = await setup({
          outbox,
          executor: {
            async execute(params) {
              const stored = await s.env.data.users.get(TENANT, USER);
              expect(
                trigger === "post-user-update" ? stored?.name : stored,
              ).toBe(trigger === "post-user-update" ? "After" : null);
              calls.push(params);
              return local.execute(params);
            },
          },
        });
        await s.bind(trigger, "console.log(event.idempotency_key)");
        const response =
          trigger === "post-user-update"
            ? await s.request("PATCH", undefined, { name: "After" })
            : await s.request("DELETE");
        expect(response.status).toBe(
          trigger === "post-user-update" ? 200 : 204,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].event).toMatchObject({
          user_id: USER,
          tenant: { id: TENANT },
        });
        expect(typeof calls[0].event.idempotency_key).toBe("string");
        expect(calls[0].event.user).not.toHaveProperty(
          "registration_completed_at",
        );
        if (trigger === "post-user-update") {
          expect(calls[0].event).toMatchObject({
            previous_user: { name: "Before" },
            updates: { name: "After" },
            user: { name: "After" },
          });
        }
      },
    );

    it("retries failed delivery with the same idempotency key without undoing the write", async () => {
      let succeeds = false;
      const calls: Parameters<CodeExecutor["execute"]>[0][] = [];
      const executor: CodeExecutor = {
        async execute(params) {
          calls.push(params);
          return {
            success: succeeds,
            error: succeeds ? undefined : "unavailable",
            durationMs: 1,
            apiCalls: [],
          };
        },
      };
      const s = await setup({ outbox: true, executor });
      await s.bind(trigger);
      const response =
        trigger === "post-user-update"
          ? await s.request("PATCH", undefined, { name: "After" })
          : await s.request("DELETE");
      expect(response.status).toBe(trigger === "post-user-update" ? 200 : 204);
      const eventId = calls[0].event.idempotency_key as string;
      const [event] = await s.env.data.outbox!.getByIds([eventId]);
      expect(event.retry_count).toBe(1);
      const destination = new CodeHookDestination(s.env.data, executor);
      succeeds = true;
      await destination.deliver([destination.transform(event)]);
      expect(calls).toHaveLength(2);
      expect(calls[1].event.idempotency_key).toBe(eventId);
      const stored = await s.env.data.users.get(TENANT, USER);
      expect(trigger === "post-user-update" ? stored?.name : stored).toBe(
        trigger === "post-user-update" ? "After" : null,
      );
    });
  });
}

it.each(["post-user-update", "post-user-deletion"] as const)(
  "%s retains failed delivery when the executor is missing",
  async (trigger) => {
    const s = await setup({ executor: null, outbox: true });
    await s.bind(trigger);
    const response =
      trigger === "post-user-update"
        ? await s.request("PATCH", undefined, { name: "After" })
        : await s.request("DELETE");
    expect(response.status).toBe(trigger === "post-user-update" ? 200 : 204);
    expect(s.executions).toHaveLength(1);
    expect(s.executions[0].results[0].error?.msg).toContain("No code executor");
    expect(s.executions[0].status).toBe("partial");
  },
);

it("removes credentials and internal bookkeeping before persisting update snapshots", async () => {
  const s = await setup({ outbox: true });
  const user = (await s.env.data.users.get(TENANT, USER))!;
  const updates = {
    name: "After",
    registration_completed_at: "internal-marker",
    password: "plaintext-secret",
    password_hash: "password-hash",
    custom_password_hash: { hash: "custom-hash" },
  };
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.get("/", (ctx) =>
    ctx.json(
      buildPostHookEvent(
        ctx,
        TENANT,
        "post-user-update",
        {
          ...user,
          ...updates,
        },
        { previousUser: { ...user, ...updates, name: "Before" }, updates },
      ),
    ),
  );
  const response = await app.request("/", {}, s.env);
  const event = await response.json();
  expect(event.details.updates).toEqual({ name: "After" });
  expect(event.target.before.name).toBe("Before");
  expect(event.target.after.name).toBe("After");
  const serialized = JSON.stringify(event);
  for (const secret of [
    "internal-marker",
    "plaintext-secret",
    "password-hash",
    "custom-hash",
    "registration_completed_at",
  ]) {
    expect(serialized).not.toContain(secret);
  }
});

it.each(Object.keys(handlerNames) as Trigger[])(
  "binds and lists %s through the Management API",
  async (trigger) => {
    const s = await setup();
    const { action, hook } = await s.bind(trigger);
    await s.env.data.hooks.remove(TENANT, hook.hook_id);
    const response = await s.request(
      "PATCH",
      `/actions/triggers/${trigger}/bindings`,
      { bindings: [{ ref: { type: "action_id", value: action.id } }] },
    );
    expect(response.status).toBe(200);
    const listed = await (
      await s.request("GET", `/actions/triggers/${trigger}/bindings`)
    ).json();
    expect(listed.bindings[0].action.id).toBe(action.id);
    expect(listed.bindings[0].trigger_id).toBe(trigger);
  },
);
