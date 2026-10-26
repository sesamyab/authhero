import { beforeEach, describe, expect, it } from "vitest";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import { seedTenant } from "../../helpers/seed-tenant";
import { getExecutorData, isSyncedRowId } from "../../../src";

// Rows delivered by a config sync carry the `sy` marker in their id. Platform
// copies of them must run but never be visible to the tenant's own admin.
const sy = (prefix: string, tail = "0") => `${prefix}sy${tail.padEnd(15, "0")}`;

const CODE = "exports.onExecutePostLogin = async () => {};";
const PLATFORM_CODE =
  "exports.onExecutePostLogin = async () => { /* platform secret logic */ };";

// List routes answer with a bare array or a wrapped object.
const items = <T>(body: unknown, key: string): T[] =>
  (Array.isArray(body)
    ? body
    : ((body as Record<string, T[]>)[key] ?? [])) as T[];

async function setup() {
  const { managementApp, env } = await getTestServer();
  env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };
  await seedTenant(env.data, "control_plane");

  const data = env.data;
  const tenant = "tenantId";

  // Platform copies, as a sync delivers them.
  const platformAction = await data.actions.create(
    tenant,
    {
      name: "platform-action",
      code: PLATFORM_CODE,
      scope: "platform",
      secrets: [{ name: "KEY", value: "platform-secret-value" }],
    },
    { importMetadata: { id: sy("act_") } },
  );
  await data.hookCode.create(
    tenant,
    { code: PLATFORM_CODE, secrets: { TOKEN: "hook-secret-value" } },
    { importMetadata: { id: sy("hc_") } },
  );
  await data.hooks.create(tenant, {
    hook_id: sy("h_"),
    trigger_id: "post-user-login",
    code_id: sy("hc_"),
    enabled: true,
    scope: "platform",
  } as never);
  await data.connections.create(tenant, {
    id: sy("con_"),
    name: "platform-conn",
    strategy: "google-oauth2",
    options: { client_id: "x", client_secret: "platform-conn-secret" },
    scope: "platform",
  });
  await data.resourceServers.create(tenant, {
    id: sy("api_"),
    identifier: "https://platform.example.com",
    name: "platform-api",
    scope: "platform",
  });

  // The tenant's own rows, including one it published itself with the platform
  // flag (non-synced id): visible to its owner.
  await data.actions.create(tenant, { name: "own-action", code: CODE });
  await data.actions.create(tenant, {
    name: "own-origin-platform",
    code: CODE,
    scope: "platform",
  });

  const tenantAdmin = await getAdminToken({ tenant_id: tenant });
  const operator = await getAdminToken({ tenant_id: "control_plane" });

  const call = (path: string, token: string, init: RequestInit = {}) =>
    managementApp.request(
      path,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": tenant,
          "content-type": "application/json",
          ...init.headers,
        },
      },
      env,
    );

  return { env, call, tenantAdmin, operator, platformAction };
}

describe("platform-scoped rows in the tenant management API", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("agrees with the id marker the sync writes", () => {
    expect(isSyncedRowId(sy("act_"))).toBe(true);
    expect(isSyncedRowId("act_abc123")).toBe(false);
    expect(isSyncedRowId("zz_sy000000000000000")).toBe(false);
  });

  describe("tenant admin", () => {
    it("does not list platform actions, hooks, connections or resource servers", async () => {
      const { call, tenantAdmin } = ctx;

      const actions = items<{ name: string }>(
        await (await call("/actions/actions", tenantAdmin)).json(),
        "actions",
      );
      expect(actions.map((a) => a.name).sort()).toEqual([
        "own-action",
        "own-origin-platform",
      ]);

      expect(
        items(await (await call("/hooks", tenantAdmin)).json(), "hooks"),
      ).toHaveLength(0);

      const connectionNames = items<{ name: string }>(
        await (await call("/connections", tenantAdmin)).json(),
        "connections",
      ).map((c) => c.name);
      expect(connectionNames).not.toContain("platform-conn");

      const identifiers = items<{ identifier: string }>(
        await (await call("/resource-servers", tenantAdmin)).json(),
        "resource_servers",
      ).map((r) => r.identifier);
      expect(identifiers).not.toContain("https://platform.example.com");
    });

    it("gets 404 for platform rows by id, on every verb", async () => {
      const { call, tenantAdmin, platformAction } = ctx;

      for (const [path, methods] of [
        [`/actions/actions/${platformAction.id}`, ["GET", "PATCH", "DELETE"]],
        [`/actions/actions/${platformAction.id}/versions`, ["GET"]],
        [`/hooks/${sy("h_")}`, ["GET", "PATCH", "DELETE"]],
        [`/hook-code/${sy("hc_")}`, ["GET", "PATCH", "DELETE"]],
        [`/connections/${sy("con_")}`, ["GET", "PATCH", "DELETE"]],
        [`/resource-servers/${sy("api_")}`, ["GET", "PATCH", "DELETE"]],
      ] as const) {
        for (const method of methods) {
          const response = await call(path, tenantAdmin, {
            method,
            ...(method === "PATCH"
              ? { body: JSON.stringify({ name: "x" }) }
              : {}),
          });
          expect(
            response.status,
            `${method} ${path} must look like it does not exist`,
          ).toBe(404);
        }
      }

      // Nothing was touched by the refused writes.
      expect(
        (await ctx.env.data.actions.get("tenantId", platformAction.id))?.name,
      ).toBe("platform-action");
    });

    it("never returns platform code or secrets from any list", async () => {
      const { call, tenantAdmin } = ctx;
      for (const path of [
        "/actions/actions",
        "/hooks",
        "/connections",
        "/resource-servers",
      ]) {
        const text = await (await call(path, tenantAdmin)).text();
        expect(text).not.toContain("platform secret logic");
        expect(text).not.toContain("platform-secret-value");
        expect(text).not.toContain("hook-secret-value");
        expect(text).not.toContain("platform-conn-secret");
      }
    });

    it("cannot point a new hook at platform code", async () => {
      const { call, tenantAdmin, platformAction } = ctx;

      for (const codeId of [platformAction.id, sy("hc_")]) {
        const response = await call("/hooks", tenantAdmin, {
          method: "POST",
          body: JSON.stringify({
            trigger_id: "post-user-login",
            code_id: codeId,
            enabled: true,
          }),
        });
        expect(response.status).toBe(404);
      }
    });

    it("cannot run or try platform rows", async () => {
      const { env, call, tenantAdmin, platformAction } = ctx;
      // The route needs an executor before it looks the action up; the stub
      // must never be reached for a hidden action.
      env.codeExecutor = {
        execute: async () => {
          throw new Error("executor must not run for a hidden action");
        },
      } as never;

      expect(
        (
          await call(
            `/actions/actions/${platformAction.id}/test`,
            tenantAdmin,
            {
              method: "POST",
              body: JSON.stringify({ payload: {} }),
            },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await call(`/hooks/${sy("h_")}/try`, tenantAdmin, {
            method: "POST",
            body: JSON.stringify({ user_id: "userId" }),
          })
        ).status,
      ).toBe(404);
    });

    it("keeps hidden connections enabled for a client when the tenant edits its connections", async () => {
      const { env, call, tenantAdmin } = ctx;
      await env.data.clients.create("tenantId", {
        client_id: "app",
        name: "App",
        callbacks: [],
        allowed_origins: [],
        web_origins: [],
        client_secret: "s",
      } as never);
      const own = await env.data.connections.create("tenantId", {
        name: "own-conn",
        strategy: "auth0",
        options: {},
      });
      await env.data.clientConnections.updateByClient("tenantId", "app", [
        sy("con_"),
        own.id,
      ]);

      // The admin does not see the hidden connection...
      const text = await (
        await call("/clients/app/connections", tenantAdmin)
      ).text();
      expect(text).not.toContain("platform-conn");

      // ...and saving a new selection must not drop it.
      await call("/clients/app/connections", tenantAdmin, {
        method: "PATCH",
        body: JSON.stringify([{ connection_id: own.id }]),
      });
      const stored = await env.data.clientConnections.listByClient(
        "tenantId",
        "app",
      );
      expect(stored.map((c) => c.id)).toContain(sy("con_"));
    });

    it("leaves platform rows out of a tenant export", async () => {
      const { call, tenantAdmin } = ctx;
      const response = await call(
        "/tenant-data/export?gzip=false",
        tenantAdmin,
      );
      expect(response.status).toBe(200);
      const text = await response.text();

      expect(text).toContain("own-action");
      expect(text).not.toContain("platform-action");
      expect(text).not.toContain("platform secret logic");
      expect(text).not.toContain("platform-secret-value");
      expect(text).not.toContain("hook-secret-value");
      expect(text).not.toContain("platform-conn");
    });

    it("leaves the executor's stack able to read platform rows", async () => {
      // `env.data` here is the raw stack hooks run against; the filter exists
      // only on the management request stack.
      const { hooks } = await ctx.env.data.hooks.list("tenantId");
      expect(hooks.map((h) => (h as { hook_id: string }).hook_id)).toContain(
        sy("h_"),
      );
    });
  });

  describe("executor stack", () => {
    it("still reads platform hooks inside a management request, while routes do not", async () => {
      // The inline hook runners (pre-registration, ...) read `getExecutorData`.
      // It must see the platform hook even though `ctx.var.data` hides it.
      const seen: { routeHooks: number; executorHooks: number }[] = [];
      const { managementApp, env } = await getTestServer({
        managementApiMiddleware: [
          async (ctx, next) => {
            const routeData = ctx.get("data");
            const executorData = getExecutorData(ctx);
            const tenantId = ctx.get("tenant_id");
            seen.push({
              routeHooks: (await routeData.hooks.list(tenantId)).hooks.length,
              executorHooks: (await executorData.hooks.list(tenantId)).hooks
                .length,
            });
            await next();
          },
        ],
      });
      env.data.multiTenancyConfig = { controlPlaneTenantId: "control_plane" };
      await env.data.hooks.create("tenantId", {
        hook_id: sy("h_"),
        trigger_id: "post-user-login",
        url: "https://example.com/hook",
        enabled: true,
        scope: "platform",
      } as never);

      const response = await managementApp.request(
        "/hooks",
        {
          headers: {
            authorization: `Bearer ${await getAdminToken({ tenant_id: "tenantId" })}`,
            "tenant-id": "tenantId",
          },
        },
        env,
      );

      expect(response.status).toBe(200);
      expect(seen).toEqual([{ routeHooks: 0, executorHooks: 1 }]);
    });
  });

  describe("operator (control-plane credential)", () => {
    it("sees platform rows on the child tenant", async () => {
      const { call, operator, platformAction } = ctx;

      const actions = items<{ name: string }>(
        await (await call("/actions/actions", operator)).json(),
        "actions",
      );
      expect(actions.map((a) => a.name)).toContain("platform-action");
      expect(
        (await call(`/actions/actions/${platformAction.id}`, operator)).status,
      ).toBe(200);
      expect((await call(`/hooks/${sy("h_")}`, operator)).status).toBe(200);
      expect((await call(`/connections/${sy("con_")}`, operator)).status).toBe(
        200,
      );
    });
  });
});
