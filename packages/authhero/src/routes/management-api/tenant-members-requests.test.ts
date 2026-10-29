import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type {
  TenantMemberRequest,
  TenantMemberRequestsAdapter,
} from "@authhero/adapter-interfaces";
import { createTenantMembersRoutes } from "./tenant-members";
import type { TenantMembersBackend } from "../../tenant-members/types";
import type { TenantMemberRequestsConfig } from "../../tenant-members/requests";

function memoryStore(): TenantMemberRequestsAdapter & {
  rows: TenantMemberRequest[];
} {
  const rows: TenantMemberRequest[] = [];
  return {
    rows,
    async create(tenantId, request) {
      const now = new Date().toISOString();
      const row: TenantMemberRequest = {
        ...request,
        id: `tmr_${rows.length + 1}`,
        tenant_id: tenantId,
        status: "pending",
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      return row;
    },
    async get(tenantId, id) {
      return rows.find((r) => r.tenant_id === tenantId && r.id === id) ?? null;
    },
    async list(tenantId, params) {
      const requests = rows.filter(
        (r) =>
          r.tenant_id === tenantId &&
          (!params?.status || r.status === params.status),
      );
      return { requests, start: 0, limit: 50, length: requests.length };
    },
    async update() {
      return true;
    },
    async cleanup() {
      return 0;
    },
  };
}

function backend(): TenantMembersBackend {
  return {
    listMembers: vi.fn(async () => ({
      members: [],
      start: 0,
      limit: 25,
      total: 0,
    })),
    addMembers: vi.fn(async () => {}),
    removeMembers: vi.fn(async () => {}),
    listMemberRoles: vi.fn(async () => []),
    assignMemberRoles: vi.fn(async () => {}),
    removeMemberRoles: vi.fn(async () => {}),
    listRoles: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []),
    createInvitation: vi.fn(async () => ({}) as never),
    revokeInvitation: vi.fn(async () => {}),
  };
}

function makeApp(options: {
  requests?: TenantMemberRequestsConfig;
  store?: TenantMemberRequestsAdapter;
  sub?: string | null;
  backend?: TenantMembersBackend;
}) {
  const app = new Hono();
  app.use(async (c, next) => {
    c.set("tenant_id" as never, "acme" as never);
    c.set("org_name" as never, "acme" as never);
    c.set("data" as never, { tenantMemberRequests: options.store } as never);
    if (options.sub !== null) {
      c.set(
        "user" as never,
        { sub: options.sub ?? "auth0|admin", tenant_id: "acme" } as never,
      );
    }
    await next();
  });
  const b = options.backend ?? backend();
  app.route(
    "/tenant-members",
    createTenantMembersRoutes(() => b, options.requests),
  );
  const call = (path: string, init?: RequestInit) =>
    app.fetch(
      new Request(`http://x/tenant-members${path === "/" ? "" : path}`, init),
    );
  return { call, backend: b };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("tenant-members writes as requests", () => {
  it("stores an invitation as a pending request and answers 202 without acting", async () => {
    const store = memoryStore();
    const { call, backend: b } = makeApp({ requests: {}, store });

    const res = await call(
      "/invitations",
      json("POST", { invitee: { email: "new@example.com" } }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: "tmr_1", status: "pending" });
    expect(store.rows[0]).toMatchObject({
      kind: "invite",
      tenant_id: "acme",
      requested_by: "auth0|admin",
    });
    expect(b.createInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/", { user_ids: ["u1"] }, "add_members", { user_ids: ["u1"] }],
    [
      "DELETE",
      "/",
      { user_ids: ["u1"] },
      "remove_members",
      { user_ids: ["u1"] },
    ],
    [
      "POST",
      "/u1/roles",
      { roles: ["r1"] },
      "assign_roles",
      { user_id: "u1", roles: ["r1"] },
    ],
    [
      "DELETE",
      "/u1/roles",
      { roles: ["r1"] },
      "remove_roles",
      { user_id: "u1", roles: ["r1"] },
    ],
  ])("registers %s %s as %s", async (method, path, body, kind, payload) => {
    const store = memoryStore();
    const { call } = makeApp({ requests: {}, store });

    const res = await call(path, json(method, body));

    expect(res.status).toBe(202);
    expect(store.rows[0]).toMatchObject({ kind, payload });
  });

  it("registers a revoke without a body", async () => {
    const store = memoryStore();
    const { call } = makeApp({ requests: {}, store });

    const res = await call("/invitations/inv_1", { method: "DELETE" });

    expect(res.status).toBe(202);
    expect(store.rows[0]).toMatchObject({
      kind: "revoke_invitation",
      payload: { invitation_id: "inv_1" },
    });
  });

  it("hands the stored request over, and still answers 202 when that fails", async () => {
    const store = memoryStore();
    const afterRegister = vi.fn(async () => {
      throw new Error("control plane is down");
    });
    const { call } = makeApp({ requests: { afterRegister }, store });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await call("/", json("POST", { user_ids: ["u1"] }));

    expect(res.status).toBe(202);
    expect(afterRegister).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "tmr_1", status: "pending" }),
    );
    expect(store.rows).toHaveLength(1);
  });

  it("reports the status an inline deployment already reached", async () => {
    const store = memoryStore();
    const afterRegister = vi.fn(async (_ctx, request: TenantMemberRequest) => {
      store.rows.find((r) => r.id === request.id)!.status = "succeeded";
    });
    const { call } = makeApp({ requests: { afterRegister }, store });

    const res = await call("/", json("POST", { user_ids: ["u1"] }));

    expect(await res.json()).toEqual({ id: "tmr_1", status: "succeeded" });
  });

  it("still pins the tenant before registering anything", async () => {
    const store = memoryStore();
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("tenant_id" as never, "acme" as never);
      c.set("org_name" as never, "evil" as never);
      c.set("data" as never, { tenantMemberRequests: store } as never);
      c.set("user" as never, { sub: "auth0|admin" } as never);
      await next();
    });
    app.route(
      "/tenant-members",
      createTenantMembersRoutes(() => backend(), {}),
    );

    const res = await app.fetch(
      new Request(
        "http://x/tenant-members",
        json("POST", { user_ids: ["u1"] }),
      ),
    );

    expect(res.status).toBe(403);
    expect(store.rows).toHaveLength(0);
  });

  it("needs a signed-in administrator and a request store", async () => {
    const noUser = makeApp({ requests: {}, store: memoryStore(), sub: null });
    expect(
      (await noUser.call("/", json("POST", { user_ids: ["u1"] }))).status,
    ).toBe(403);

    const noStore = makeApp({ requests: {} });
    expect(
      (await noStore.call("/", json("POST", { user_ids: ["u1"] }))).status,
    ).toBe(501);
  });

  it("keeps the synchronous behaviour when requests are not enabled", async () => {
    const { call, backend: b } = makeApp({ store: memoryStore() });

    const res = await call("/", json("POST", { user_ids: ["u1"] }));

    expect(res.status).toBe(204);
    expect(b.addMembers).toHaveBeenCalledWith("acme", ["u1"]);
  });
});

describe("GET /tenant-members/requests", () => {
  it("lists this tenant's requests, optionally by status", async () => {
    const store = memoryStore();
    const { call } = makeApp({ requests: {}, store });
    await call("/", json("POST", { user_ids: ["u1"] }));
    await call("/", json("DELETE", { user_ids: ["u2"] }));
    store.rows[0]!.status = "failed";

    const all = await (await call("/requests")).json();
    expect(all.requests).toHaveLength(2);
    expect(all).toMatchObject({ start: 0, limit: 50, length: 2 });
    const failed = await (await call("/requests?status=failed")).json();
    expect(failed.requests.map((r: { id: string }) => r.id)).toEqual(["tmr_1"]);
  });

  it("is not available without requests enabled", async () => {
    const { call } = makeApp({ store: memoryStore() });
    expect((await call("/requests")).status).toBe(501);
  });
});
