import { describe, it, expect, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

// Checkpoint (from/take) pagination on hooks, actions, forms, flows and grants.
describe("config lists checkpoint pagination", () => {
  const tenantId = "tenantId";
  const pad = (i: number) => i.toString().padStart(2, "0");
  let client: any;
  let env: Awaited<ReturnType<typeof getTestServer>>["env"];
  let token: string;

  beforeEach(async () => {
    const server = await getTestServer();
    env = server.env;
    client = testClient(server.managementApp, env);
    token = await getAdminToken();
  });

  async function walk(
    route: any,
    itemsKey: string,
    key: (item: any) => string,
  ) {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const response = await route.$get(
        {
          query: { take: "10", ...(from ? { from } : {}) },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(false);
      expect("start" in body).toBe(false);
      seen.push(...body[itemsKey].map(key));
      from = body.next;
      if (from) expect(from).not.toMatch(/^\d+$/);
      if (++pages > 6) throw new Error("cursor walk did not terminate");
    } while (from);
    return { seen, pages };
  }

  it("walks hooks", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.hooks.create(tenantId, {
        hook_id: `hook-${pad(i)}`,
        url: `https://example.com/hook-${i}`,
        trigger_id: "post-user-login",
        enabled: true,
        synchronous: false,
      });
    }
    const { seen, pages } = await walk(client.hooks, "hooks", (h) => h.hook_id);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks actions and keeps secret values out", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.actions.create(tenantId, {
        name: `action-${pad(i)}`,
        code: "exports.onExecutePostLogin = async () => {};",
        supported_triggers: [{ id: "post-login" }],
        secrets: [{ name: "KEY", value: "secret" }],
      });
    }
    const { seen, pages } = await walk(
      client.actions.actions,
      "actions",
      (a) => a.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    const first = await client.actions.actions.$get(
      { query: { take: "1" }, header: { "tenant-id": tenantId } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await first.json();
    expect(body.actions[0].secrets).toEqual([{ name: "KEY" }]);
  });

  it("walks forms", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.forms.create(tenantId, { name: `form-${pad(i)}` });
    }
    const { seen, pages } = await walk(client.forms, "forms", (f) => f.id);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks flows", async () => {
    for (let i = 0; i < 25; i++) {
      await env.data.flows.create(tenantId, { name: `flow-${pad(i)}` });
    }
    const { seen, pages } = await walk(client.flows, "flows", (f) => f.id);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks grants and keeps the offset shape for plain requests", async () => {
    await env.data.users.create(tenantId, {
      user_id: "auth2|alice",
      email: "alice@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });
    for (let i = 0; i < 25; i++) {
      await env.data.grants!.create(tenantId, {
        user_id: "auth2|alice",
        clientID: "client",
        audience: `https://api-${pad(i)}.example.com`,
        scope: ["read"],
      });
    }
    const { seen, pages } = await walk(client.grants, "grants", (g) => g.id);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    const plain = await client.grants.$get(
      { query: {}, header: { "tenant-id": tenantId } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(Array.isArray(await plain.json())).toBe(true);
  });
});
