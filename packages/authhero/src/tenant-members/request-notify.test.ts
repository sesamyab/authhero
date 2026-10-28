import { describe, it, expect, vi } from "vitest";
import type { TenantMemberRequest } from "@authhero/adapter-interfaces";
import { createControlPlaneRequestNotifier } from "./request-notifier";
import { createTenantMembersControlPlaneApp } from "../routes/proxy-control-plane/tenant-members";
import { CONTROL_PLANE_TENANT_MEMBER_REQUESTS_NOTIFY_PATH } from "./wire";

const request: TenantMemberRequest = {
  id: "tmr_1",
  tenant_id: "acme",
  kind: "add_members",
  status: "pending",
  requested_by: "auth0|admin",
  payload: { user_ids: ["u1"] },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function ctxWith(update = vi.fn(async () => true)) {
  return {
    ctx: { env: { data: { tenantMemberRequests: { update } } } } as never,
    update,
  };
}

describe("createControlPlaneRequestNotifier", () => {
  it("tells the control plane with the request id and records that it was told", async () => {
    const send = vi.fn(async () => ({ status: 202, data: null }));
    const { ctx, update } = ctxWith();

    await createControlPlaneRequestNotifier({ request: send })(ctx, request);

    expect(send).toHaveBeenCalledWith({
      tenantId: "acme",
      scope: "controlplane:tenant_members",
      method: "POST",
      path: CONTROL_PLANE_TENANT_MEMBER_REQUESTS_NOTIFY_PATH,
      body: { request_id: "tmr_1" },
    });
    expect(update).toHaveBeenCalledWith("acme", "tmr_1", {
      notified_at: expect.any(String),
    });
  });

  it("leaves the request unnotified when the control plane refuses or is unreachable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = ctxWith();
    await createControlPlaneRequestNotifier({
      request: async () => ({ status: 502, data: null }),
    })(refused.ctx, request);
    expect(refused.update).not.toHaveBeenCalled();

    const down = ctxWith();
    await expect(
      createControlPlaneRequestNotifier({
        request: async () => {
          throw new Error("timeout");
        },
      })(down.ctx, request),
    ).resolves.toBeUndefined();
    expect(down.update).not.toHaveBeenCalled();
  });
});

describe("POST /tenant-members/requests/notify on the control plane", () => {
  function app(
    options: {
      onNotify?: ReturnType<typeof vi.fn>;
      authenticate?: () => Promise<
        { ok: true; tenantId?: string } | { ok: false; reason: string }
      >;
      withRequests?: boolean;
    } = {},
  ) {
    const onNotify = options.onNotify ?? vi.fn(async () => {});
    const cp = createTenantMembersControlPlaneApp({
      getBackend: () => ({}) as never,
      authenticate:
        (options.authenticate as never) ??
        (async () => ({ ok: true, tenantId: "acme" })),
      requests:
        options.withRequests === false
          ? undefined
          : { onNotify: onNotify as never },
    });
    const call = (body: unknown) =>
      cp.fetch(
        new Request("http://cp/requests/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    return { call, onNotify };
  }

  it("hands the request to the control plane under the token's tenant", async () => {
    const { call, onNotify } = app();

    const res = await call({ request_id: "tmr_1" });

    expect(res.status).toBe(202);
    expect(onNotify).toHaveBeenCalledWith(expect.anything(), "acme", "tmr_1");
  });

  it("refuses a body that names another tenant", async () => {
    const { call, onNotify } = app();
    expect(
      (await call({ request_id: "tmr_1", tenant_id: "other" })).status,
    ).toBe(403);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it("needs a request id, a verified tenant and a configured control plane", async () => {
    expect((await app().call({})).status).toBe(400);
    expect(
      (
        await app({
          authenticate: async () => ({ ok: false, reason: "bad token" }),
        }).call({ request_id: "tmr_1" })
      ).status,
    ).toBe(401);
    expect(
      (
        await app({ authenticate: async () => ({ ok: true }) }).call({
          request_id: "tmr_1",
        })
      ).status,
    ).toBe(403);
    expect(
      (await app({ withRequests: false }).call({ request_id: "tmr_1" })).status,
    ).toBe(501);
  });
});
