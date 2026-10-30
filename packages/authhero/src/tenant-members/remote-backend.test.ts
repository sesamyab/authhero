import { describe, it, expect } from "vitest";
import type {
  ControlPlaneClient,
  ControlPlaneResponse,
} from "../helpers/control-plane-client";
import { createControlPlaneTenantMembersAdapter } from "./remote-backend";
import {
  TenantInvitationNotFoundError,
  TenantOrganizationNotFoundError,
} from "./types";
import { TENANT_MEMBERS_NOT_FOUND_HEADER } from "./wire";

function adapterAnswering(response: ControlPlaneResponse) {
  const client: ControlPlaneClient = { request: async () => response };
  return createControlPlaneTenantMembersAdapter({ client });
}

describe("control-plane tenant-members adapter: 404", () => {
  it("reads the resource's own plain-text 'Not found' as a missing team", async () => {
    const adapter = adapterAnswering({
      status: 404,
      data: null,
      text: "Not found",
    });
    await expect(adapter.listMembers("acme")).rejects.toBeInstanceOf(
      TenantOrganizationNotFoundError,
    );
    await expect(
      adapter.revokeInvitation("acme", "inv_1"),
    ).rejects.toBeInstanceOf(TenantOrganizationNotFoundError);
  });

  it("reads the not-found header even when the body was lost", async () => {
    const adapter = adapterAnswering({
      status: 404,
      data: null,
      text: "",
      headers: new Headers({
        [TENANT_MEMBERS_NOT_FOUND_HEADER]: "organization",
      }),
    });
    await expect(adapter.listMembers("acme")).rejects.toBeInstanceOf(
      TenantOrganizationNotFoundError,
    );
  });

  it("tells a missing invitation from a missing team by the header", async () => {
    const adapter = adapterAnswering({
      status: 404,
      data: null,
      text: "Not found",
      headers: new Headers({ [TENANT_MEMBERS_NOT_FOUND_HEADER]: "invitation" }),
    });
    const error = await adapter
      .revokeInvitation("acme", "inv_gone")
      .catch((e) => e);
    expect(error).toBeInstanceOf(TenantInvitationNotFoundError);
    expect(error).not.toBeInstanceOf(TenantOrganizationNotFoundError);
  });

  it("keeps reading a 404 as a missing team when the client reports no body", async () => {
    const adapter = adapterAnswering({ status: 404, data: null });
    await expect(adapter.listMembers("acme")).rejects.toBeInstanceOf(
      TenantOrganizationNotFoundError,
    );
  });

  it.each([
    ["an unmounted route", "404 Not Found"],
    ["an origin page", "<html>Not Found</html>"],
    ["an empty body", ""],
  ])("does not read %s as a missing team", async (_name, text) => {
    const adapter = adapterAnswering({ status: 404, data: null, text });
    const error = await adapter.listMembers("acme").catch((e) => e);
    expect(error).not.toBeInstanceOf(TenantOrganizationNotFoundError);
    expect(error.status).toBe(502);
    expect(error.message).toContain("status 404");
  });

  it("names the status for a JSON 404 from another route too", async () => {
    const adapter = adapterAnswering({
      status: 404,
      data: { message: "no such route" },
      text: '{"message":"no such route"}',
    });
    const error = await adapter.addMembers("acme", ["u1"]).catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.message).toContain("status 404");
  });

  it("still passes other 4xx through with their status", async () => {
    const adapter = adapterAnswering({
      status: 403,
      data: null,
      text: "Forbidden",
    });
    const error = await adapter.listMembers("acme").catch((e) => e);
    expect(error.status).toBe(403);
  });
});
