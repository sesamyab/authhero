import { beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import type { TenantMembersBackend } from "authhero";
import {
  createInlineExecutor,
  createOperationRecorder,
  enqueueTenantMemberRequest,
  reconcileTenantMemberRequests,
  runTenantMembersRequestStep,
} from "@authhero/multi-tenancy";
import {
  createDispatchTenantMemberRequestStore,
  createWfpTenantApp,
} from "../src/wfp";

const CP = "control_plane";

function b64Key(seed: number): string {
  return Buffer.from(new Uint8Array(32).fill(seed)).toString("base64");
}

async function makeAdapters(): Promise<DataAdapters> {
  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrateToLatest(db, false);
  return createAdapters(db) as DataAdapters;
}

const tenantRow = (id: string) => ({
  id,
  friendly_name: id,
  audience: "https://example.com",
  default_audience: "https://example.com",
  sender_email: "login@example.com",
  sender_name: "Sender",
});

function backend(
  overrides: Partial<TenantMembersBackend> = {},
): TenantMembersBackend {
  return {
    listMembers: vi.fn(async () => ({
      members: [],
      start: 0,
      limit: 25,
      total: 0,
    })),
    addMembers: vi.fn(async () => {}),
    removeMembers: vi.fn(async () => {}),
    listMemberRoles: vi.fn(async () => [{ id: "rol_admin" } as never]),
    assignMemberRoles: vi.fn(async () => {}),
    removeMemberRoles: vi.fn(async () => {}),
    listRoles: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []),
    createInvitation: vi.fn(async () => ({ id: "inv_new" }) as never),
    revokeInvitation: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("team-change requests over the dispatch transport (/internal/tenant-member-requests)", () => {
  const env = {
    AUTH_DB: {},
    ENCRYPTION_KEY: b64Key(1),
    ISSUER: "https://acme.tokens.example.com/",
    CONTROL_PLANE_TENANT_ID: CP,
    CONTROL_PLANE_ISSUER: "https://controlplane.example.com/",
    WFP_INTERNAL_SYNC_SECRET: "push-secret",
    TENANT_ID: "acme",
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  let cp: DataAdapters;
  let tenant: DataAdapters;
  let app: ReturnType<typeof createWfpTenantApp>;
  let calls: string[];

  const dispatcherToTenant = (tenantEnv: Record<string, unknown> = env) => ({
    get() {
      return {
        async fetch(url: Request | string, init?: RequestInit) {
          calls.push(typeof url === "string" ? url : url.url);
          return app.fetch(new Request(url, init), tenantEnv, ctx);
        },
      };
    },
  });

  const storeFor = (
    dispatcher = dispatcherToTenant(),
    secret = "push-secret",
  ) =>
    createDispatchTenantMemberRequestStore({
      dispatcher,
      internalSecret: secret,
    });

  const register = () =>
    tenant.tenantMemberRequests!.create("acme", {
      kind: "add_members",
      requested_by: "auth0|admin",
      payload: { user_ids: ["u1"] },
    });

  beforeEach(async () => {
    calls = [];
    cp = await makeAdapters();
    tenant = await makeAdapters();
    app = createWfpTenantApp({ createDataAdapter: () => tenant });
    await cp.tenants.create(tenantRow(CP));
    await cp.tenants.create(tenantRow("acme"));
    await tenant.tenants.create(tenantRow("acme"));
  });

  it("reads a request from the tenant's own database, or null", async () => {
    const request = await register();

    expect(await storeFor().get("acme", request.id)).toMatchObject({
      id: request.id,
      status: "pending",
      payload: { user_ids: ["u1"] },
    });
    expect(await storeFor().get("acme", "tmr_missing")).toBeNull();
    expect(calls[0]).toBe(
      "https://tenant.internal/internal/tenant-member-requests",
    );
  });

  it("answers a pending request once, and a repeat changes nothing", async () => {
    const request = await register();

    expect(
      await storeFor().report("acme", request.id, {
        status: "succeeded",
        result: { invitation_id: "inv_1" },
      }),
    ).toBe(true);
    expect(
      await storeFor().report("acme", request.id, {
        status: "failed",
        error: "late",
      }),
    ).toBe(false);

    expect(
      await tenant.tenantMemberRequests!.get("acme", request.id),
    ).toMatchObject({
      status: "succeeded",
      result: { invitation_id: "inv_1" },
      finished_at: expect.any(String),
    });
  });

  it("lists the pending requests older than a moment", async () => {
    const request = await register();
    const done = await register();
    await storeFor().report("acme", done.id, { status: "failed", error: "no" });

    const later = new Date(Date.now() + 1000).toISOString();
    expect(
      (await storeFor().listPending("acme", { olderThan: later })).map(
        (r) => r.id,
      ),
    ).toEqual([request.id]);
    expect(
      await storeFor().listPending("acme", {
        olderThan: "2000-01-01T00:00:00Z",
      }),
    ).toEqual([]);
  });

  it("refuses a wrong secret and a request meant for another tenant's worker", async () => {
    const request = await register();

    await expect(
      storeFor(dispatcherToTenant(), "wrong").get("acme", request.id),
    ).rejects.toThrow(/401/);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storeFor().get("beta", request.id)).rejects.toThrow(
      /member_requests_tenant_mismatch/,
    );
  });

  it("carries a request out end to end and answers it on the tenant", async () => {
    const request = await register();
    const b = backend();
    const stores = {
      tenantOperations: cp.tenantOperations!,
      tenantOperationEvents: cp.tenantOperationEvents!,
    };
    const store = storeFor();
    const recorder = createOperationRecorder(stores);
    const executor = createInlineExecutor({
      stores,
      definitions: {
        "tenant-members-request": (operation) => [
          {
            name: "tenant-members-request",
            run: () =>
              runTenantMembersRequestStep({
                operation,
                store,
                getBackend: () => b,
                recorder,
              }),
          },
        ],
      },
    });

    const op = await enqueueTenantMemberRequest(
      { stores, executor },
      "acme",
      request.id,
    );

    expect(op.status).toBe("succeeded");
    expect(b.addMembers).toHaveBeenCalledWith("acme", ["u1"]);
    expect(
      (await tenant.tenantMemberRequests!.get("acme", request.id))!.status,
    ).toBe("succeeded");
  });

  it("is found by the sweep when the control plane was never told", async () => {
    const request = await register();
    const b = backend();
    const stores = {
      tenantOperations: cp.tenantOperations!,
      tenantOperationEvents: cp.tenantOperationEvents!,
    };
    const store = storeFor();
    const recorder = createOperationRecorder(stores);
    const executor = createInlineExecutor({
      stores,
      definitions: {
        "tenant-members-request": (operation) => [
          {
            name: "tenant-members-request",
            run: () =>
              runTenantMembersRequestStep({
                operation,
                store,
                getBackend: () => b,
                recorder,
              }),
          },
        ],
      },
    });

    const result = await reconcileTenantMemberRequests({
      stores,
      executor,
      store,
      tenantIds: () => ["acme"],
      graceMs: 0,
      now: () => new Date(Date.now() + 1000),
    });

    expect(result).toMatchObject({ enqueued: 1, unreachable: [] });
    expect(
      (await tenant.tenantMemberRequests!.get("acme", request.id))!.status,
    ).toBe("succeeded");
  });
});
