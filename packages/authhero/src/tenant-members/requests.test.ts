import { describe, it, expect, vi } from "vitest";
import {
  TenantMemberRequestRejected,
  executeTenantMemberRequest,
} from "./requests";
import {
  TenantInvitationNotFoundError,
  TenantOrganizationNotFoundError,
  type TenantMembersBackend,
} from "./types";

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

const request = (
  kind: Parameters<typeof executeTenantMemberRequest>[2]["kind"],
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  tenant_id: TENANT,
  kind,
  requested_by: "auth0|admin",
  payload,
  ...extra,
});

describe("executeTenantMemberRequest", () => {
  it("creates an invitation and reports its id", async () => {
    const b = backend();
    const result = await executeTenantMemberRequest(
      b,
      TENANT,
      request("invite", { invitee: { email: "new@example.com" } }),
    );

    expect(b.createInvitation).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ invitee: { email: "new@example.com" } }),
    );
    expect(result).toEqual({ invitation_id: "inv_new" });
  });

  it("reuses a pending invitation for the same address instead of inviting twice", async () => {
    const b = backend({
      listInvitations: vi.fn(async () => [
        { id: "inv_old", invitee: { email: "New@Example.com" } } as never,
      ]),
    });

    const result = await executeTenantMemberRequest(
      b,
      TENANT,
      request("invite", { invitee: { email: "new@example.com" } }),
    );

    expect(b.createInvitation).not.toHaveBeenCalled();
    expect(result).toEqual({ invitation_id: "inv_old" });
  });

  it.each([
    ["add_members", { user_ids: ["u1"] }, "addMembers", [TENANT, ["u1"]]],
    ["remove_members", { user_ids: ["u1"] }, "removeMembers", [TENANT, ["u1"]]],
    [
      "assign_roles",
      { user_id: "u1", roles: ["r1"] },
      "assignMemberRoles",
      [TENANT, "u1", ["r1"]],
    ],
    [
      "remove_roles",
      { user_id: "u1", roles: ["r1"] },
      "removeMemberRoles",
      [TENANT, "u1", ["r1"]],
    ],
    [
      "revoke_invitation",
      { invitation_id: "inv_1" },
      "revokeInvitation",
      [TENANT, "inv_1"],
    ],
  ] as const)("runs %s", async (kind, payload, method, args) => {
    const b = backend();
    await executeTenantMemberRequest(b, TENANT, request(kind, payload));
    expect(b[method]).toHaveBeenCalledWith(...args);
  });

  it("refuses a request for another tenant than the one the caller speaks for", async () => {
    const b = backend();
    await expect(
      executeTenantMemberRequest(
        b,
        "other",
        request("add_members", { user_ids: ["u1"] }),
      ),
    ).rejects.toThrow(TenantMemberRequestRejected);
    expect(b.addMembers).not.toHaveBeenCalled();
  });

  it("refuses a requester who is no longer an administrator, with a reason", async () => {
    const b = backend({ listMemberRoles: vi.fn(async () => []) });
    await expect(
      executeTenantMemberRequest(
        b,
        TENANT,
        request("add_members", { user_ids: ["u1"] }),
      ),
    ).rejects.toThrow(/no longer an administrator/);
    expect(b.addMembers).not.toHaveBeenCalled();
  });

  it("treats a requester of a tenant without a team as not allowed", async () => {
    const b = backend({
      listMemberRoles: vi.fn(async () => {
        throw new TenantOrganizationNotFoundError(TENANT);
      }),
    });
    await expect(
      executeTenantMemberRequest(
        b,
        TENANT,
        request("add_members", { user_ids: ["u1"] }),
      ),
    ).rejects.toThrow(TenantMemberRequestRejected);
  });

  it("lets a custom check decide who may ask", async () => {
    const b = backend({ listMemberRoles: vi.fn(async () => []) });
    await executeTenantMemberRequest(
      b,
      TENANT,
      request("add_members", { user_ids: ["u1"] }),
      { isRequesterAllowed: async () => true },
    );
    expect(b.addMembers).toHaveBeenCalled();
  });

  it("rejects a payload that does not match its kind", async () => {
    const b = backend();
    await expect(
      executeTenantMemberRequest(
        b,
        TENANT,
        request("assign_roles", { user_id: "u1" }),
      ),
    ).rejects.toThrow(/payload/);
  });

  it("counts an invitation that is already gone as done, but not a missing team", async () => {
    const gone = backend({
      revokeInvitation: vi.fn(async () => {
        throw new TenantInvitationNotFoundError("inv_1");
      }),
    });
    await expect(
      executeTenantMemberRequest(
        gone,
        TENANT,
        request("revoke_invitation", { invitation_id: "inv_1" }),
      ),
    ).resolves.toBeNull();

    const noTeam = backend({
      revokeInvitation: vi.fn(async () => {
        throw new TenantOrganizationNotFoundError(TENANT);
      }),
    });
    await expect(
      executeTenantMemberRequest(
        noTeam,
        TENANT,
        request("revoke_invitation", { invitation_id: "inv_1" }),
      ),
    ).rejects.toThrow(/no team/);
  });

  it("lets other errors through, so the operation can retry them", async () => {
    const b = backend({
      addMembers: vi.fn(async () => {
        throw new Error("database is down");
      }),
    });
    await expect(
      executeTenantMemberRequest(
        b,
        TENANT,
        request("add_members", { user_ids: ["u1"] }),
      ),
    ).rejects.toThrow("database is down");
  });
});
