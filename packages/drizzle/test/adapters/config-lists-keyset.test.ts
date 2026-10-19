import { describe, expect, it, beforeEach } from "vitest";
import { decodeCursor } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

// Checkpoint (from/take) pagination for hooks, actions, forms, flows and
// grants: fixed newest-first order with an id tiebreaker.
describe("config list keyset pagination (from/take)", () => {
  let data: ReturnType<typeof getTestServer>["data"];
  const tenantId = "t1";
  const pad = (i: number) => i.toString().padStart(2, "0");

  async function walk<T>(
    fetchPage: (
      from: string | undefined,
    ) => Promise<{ items: T[]; next?: string }>,
    key: (item: T) => string,
  ) {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await fetchPage(from);
      pages++;
      seen.push(...res.items.map(key));
      if (!res.next) break;
      from = res.next;
      if (pages > 20) throw new Error("cursor walk did not terminate");
    }
    return { seen, pages };
  }

  beforeEach(async () => {
    const server = getTestServer();
    data = server.data;
    await data.tenants.create({ id: tenantId, name: "Tenant 1" });
  });

  it("walks every hook exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      await data.hooks.create(tenantId, {
        hook_id: `hook-${pad(i)}`,
        url: `https://example.com/hook-${i}`,
        trigger_id: "post-user-login",
        enabled: true,
        synchronous: false,
      });
    }
    const { seen, pages } = await walk(
      (from) =>
        data.hooks
          .list(tenantId, { take: 10, from })
          .then((r) => ({ items: r.hooks, next: r.next })),
      (h) => h.hook_id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
    expect(pages).toBe(3);
  });

  it("walks every action exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      await data.actions.create(tenantId, {
        name: `action-${pad(i)}`,
        code: "exports.onExecutePostLogin = async () => {};",
        supported_triggers: [{ id: "post-login" }],
      });
    }
    const { seen, pages } = await walk(
      (from) =>
        data.actions
          .list(tenantId, { take: 10, from })
          .then((r) => ({ items: r.actions, next: r.next })),
      (a) => a.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks every form exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      await data.forms.create(tenantId, { name: `form-${pad(i)}` });
    }
    const { seen, pages } = await walk(
      (from) =>
        data.forms
          .list(tenantId, { take: 10, from })
          .then((r) => ({ items: r.forms, next: r.next })),
      (f) => f.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks every flow exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      await data.flows.create(tenantId, { name: `flow-${pad(i)}` });
    }
    const { seen, pages } = await walk(
      (from) =>
        data.flows
          .list(tenantId, { take: 10, from })
          .then((r) => ({ items: r.flows, next: r.next })),
      (f) => f.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks every grant exactly once and keeps q in effect", async () => {
    await data.users.create(tenantId, {
      user_id: "auth2|alice",
      email: "alice@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });
    for (let i = 0; i < 25; i++) {
      await data.grants!.create(tenantId, {
        user_id: "auth2|alice",
        clientID: "client",
        audience: `https://api-${pad(i)}.example.com`,
        scope: ["read"],
      });
    }
    const { seen, pages } = await walk(
      (from) =>
        data
          .grants!.list(tenantId, { take: 10, from })
          .then((r) => ({ items: r.grants, next: r.next })),
      (g) => g.id,
    );
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);

    const first = await data.grants!.list(tenantId, { take: 10 });
    expect(decodeCursor(first.next!)).not.toBeNull();

    const none = await data.grants!.list(tenantId, {
      take: 10,
      q: 'client_id:"other"',
    });
    expect(none.grants).toHaveLength(0);
    expect(none.next).toBeUndefined();
  });
});
