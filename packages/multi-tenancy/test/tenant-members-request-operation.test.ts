import { beforeEach, describe, expect, it, vi } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import type { TenantMembersBackend } from "authhero";
import { initMultiTenant } from "../src/init";
import {
  createInProcessMemberRequestStore,
  createInlineExecutor,
  createOperationRecorder,
  enqueueTenantMemberRequest,
  reconcileTenantMemberRequests,
  runTenantMembersRequestStep,
  type TenantMemberRequestStore,
} from "../src/operations";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const TENANT = "acme";

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

describe("tenant-members-request operation", () => {
  let adapters: ReturnType<typeof createAdapters>;
  let store: TenantMemberRequestStore;
  let b: TenantMembersBackend;

  beforeEach(async () => {
    adapters = createAdapters(await createMigratedDb());
    for (const id of [CP, TENANT, "beta"]) {
      await adapters.tenants.create({ id, friendly_name: id });
    }
    store = createInProcessMemberRequestStore(adapters);
    b = backend();
  });

  const stores = () => ({
    tenantOperations: adapters.tenantOperations!,
    tenantOperationEvents: adapters.tenantOperationEvents!,
  });

  function executor(getBackend = () => b) {
    const recorder = createOperationRecorder(stores());
    return createInlineExecutor({
      stores: stores(),
      definitions: {
        "tenant-members-request": (operation) => [
          {
            name: "tenant-members-request",
            run: () =>
              runTenantMembersRequestStep({
                operation,
                store,
                getBackend,
                recorder,
              }),
          },
        ],
      },
    });
  }

  const register = (
    tenantId = TENANT,
    kind: "add_members" | "invite" = "add_members",
    payload: Record<string, unknown> = { user_ids: ["u1"] },
  ) =>
    adapters.tenantMemberRequests!.create(tenantId, {
      kind,
      requested_by: "auth0|admin",
      payload,
    });

  it("carries out a request and answers it with the outcome", async () => {
    const request = await register();

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      request.id,
    );

    expect(op.status).toBe("succeeded");
    expect(op.input).toEqual({ request_id: request.id });
    expect(b.addMembers).toHaveBeenCalledWith(TENANT, ["u1"]);
    expect(
      await adapters.tenantMemberRequests!.get(TENANT, request.id),
    ).toMatchObject({
      status: "succeeded",
      finished_at: expect.any(String),
    });
  });

  it("stores what an invitation produced, and keeps the address out of the operation", async () => {
    const request = await register(TENANT, "invite", {
      invitee: { email: "secret@example.com" },
    });

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      request.id,
    );

    expect(
      (await adapters.tenantMemberRequests!.get(TENANT, request.id))!.result,
    ).toEqual({ invitation_id: "inv_new" });
    expect(JSON.stringify(op)).not.toContain("secret@example.com");
  });

  it("reports a request that must not run as failed with the reason, and lets the operation succeed", async () => {
    b = backend({ listMemberRoles: vi.fn(async () => []) });
    const request = await register();

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      request.id,
    );

    expect(op.status).toBe("succeeded");
    expect(op.result).toMatchObject({ outcome: "failed" });
    expect(b.addMembers).not.toHaveBeenCalled();
    const row = await adapters.tenantMemberRequests!.get(TENANT, request.id);
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toMatch(/no longer an administrator/);
  });

  it("leaves the request pending when the work fails for another reason", async () => {
    b = backend({
      addMembers: vi.fn(async () => {
        throw new Error("database is down");
      }),
    });
    const request = await register();

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      request.id,
    );

    expect(op.status).toBe("failed");
    expect(
      (await adapters.tenantMemberRequests!.get(TENANT, request.id))!.status,
    ).toBe("pending");
  });

  it("does not run a request twice, however often the control plane is told", async () => {
    const request = await register();
    const deps = { stores: stores(), executor: executor() };

    const first = await enqueueTenantMemberRequest(deps, TENANT, request.id);
    const second = await enqueueTenantMemberRequest(deps, TENANT, request.id);

    expect(second.id).toBe(first.id);
    expect(b.addMembers).toHaveBeenCalledTimes(1);
  });

  it("does not touch a request that was already finished", async () => {
    const request = await register();
    await adapters.tenantMemberRequests!.update(
      TENANT,
      request.id,
      { status: "failed", error: "earlier" },
      "pending",
    );

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      request.id,
    );

    expect(op.result).toMatchObject({ outcome: "already_finished" });
    expect(b.addMembers).not.toHaveBeenCalled();
  });

  it("fails for a request the tenant does not have", async () => {
    const other = await register("beta");

    const op = await enqueueTenantMemberRequest(
      { stores: stores(), executor: executor() },
      TENANT,
      other.id,
    );

    expect(op.status).toBe("failed");
    expect(b.addMembers).not.toHaveBeenCalled();
  });

  describe("reconcile", () => {
    const sweep = (
      overrides: Partial<
        Parameters<typeof reconcileTenantMemberRequests>[0]
      > = {},
    ) =>
      reconcileTenantMemberRequests({
        stores: stores(),
        executor: executor(),
        store,
        tenantIds: () => [TENANT, "beta"],
        graceMs: 0,
        now: () => new Date(Date.now() + 1000),
        ...overrides,
      });

    it("runs a request whose notification never arrived", async () => {
      const request = await register();

      const result = await sweep();

      expect(result).toMatchObject({ checked: 1, enqueued: 1, gaveUp: 0 });
      expect(
        (await adapters.tenantMemberRequests!.get(TENANT, request.id))!.status,
      ).toBe("succeeded");
    });

    it("leaves young requests to the notification", async () => {
      await register();

      const result = await sweep({
        graceMs: 60 * 60_000,
        now: () => new Date(),
      });

      expect(result).toMatchObject({ checked: 0, enqueued: 0 });
      expect(b.addMembers).not.toHaveBeenCalled();
    });

    it("retries a request whose run failed, and gives up after the attempts", async () => {
      b = backend({
        addMembers: vi.fn(async () => {
          throw new Error("database is down");
        }),
      });
      const request = await register();

      for (let i = 0; i < 3; i++) {
        await sweep({ maxAttempts: 3 });
      }
      expect(b.addMembers).toHaveBeenCalledTimes(3);

      const last = await sweep({ maxAttempts: 3 });
      expect(last.gaveUp).toBe(1);
      expect(b.addMembers).toHaveBeenCalledTimes(3);
      const row = await adapters.tenantMemberRequests!.get(TENANT, request.id);
      expect(row).toMatchObject({ status: "failed" });
    });

    it("names a tenant it could not read and carries on with the others", async () => {
      await register("beta");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const flaky: TenantMemberRequestStore = {
        ...store,
        listPending: async (tenantId, options) => {
          if (tenantId === TENANT) throw new Error("shard unreachable");
          return store.listPending(tenantId, options);
        },
      };

      const result = await sweep({ store: flaky });

      expect(result.unreachable).toEqual([TENANT]);
      expect(result.enqueued).toBe(1);
    });
  });

  it("is wired by initMultiTenant", async () => {
    const result = initMultiTenant({
      dataAdapter: adapters,
      controlPlane: { tenantId: CP, clientId: "control-plane-client" },
      tenantMemberRequests: { getBackend: () => b },
    });
    const request = await register();

    const op = await result.memberRequests!.enqueue(TENANT, request.id);

    expect(op.status).toBe("succeeded");
    expect(b.addMembers).toHaveBeenCalledWith(TENANT, ["u1"]);
    expect(await result.memberRequests!.reconcile()).toMatchObject({
      checked: 0,
    });
  });
});
