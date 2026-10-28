import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type {
  TenantMemberRequest,
  TenantMemberRequestKind,
} from "@authhero/adapter-interfaces";
import type { Bindings, Variables } from "../types";
import {
  TenantInvitationNotFoundError,
  TenantMembersBackend,
  TenantMembersNotFoundError,
  tenantInvitationInputSchema,
} from "./types";

/**
 * Team-change requests (issue #1550). A shard registers a request in its own
 * database and tells the control plane, which carries it out with
 * {@link executeTenantMemberRequest}. This file holds what the two ends share:
 * what each kind carries and how one is run.
 */

const userIdsPayload = z.object({ user_ids: z.array(z.string()).min(1) });
const memberRolesPayload = z.object({
  user_id: z.string(),
  roles: z.array(z.string()).min(1),
});

/** What each kind of request carries in `payload`. */
export const tenantMemberRequestPayloadSchemas = {
  invite: tenantInvitationInputSchema,
  add_members: userIdsPayload,
  remove_members: userIdsPayload,
  assign_roles: memberRolesPayload,
  remove_roles: memberRolesPayload,
  revoke_invitation: z.object({ invitation_id: z.string() }),
} satisfies Record<TenantMemberRequestKind, z.ZodTypeAny>;

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * What a deployment does once a request is stored, given the stored row. A
 * shard tells the control plane (`createControlPlaneRequestNotifier`), a
 * single-instance deployment runs it right away. A failure here never fails
 * the registration: the request stays `pending` and is picked up later.
 */
export type AfterTenantMemberRequestRegistered = (
  ctx: Ctx,
  request: TenantMemberRequest,
) => Promise<void>;

export interface TenantMemberRequestsConfig {
  afterRegister?: AfterTenantMemberRequestRegistered;
}

/**
 * The request cannot be carried out, for a reason an admin may read: it is not
 * a failure of the system, so it is not retried.
 */
export class TenantMemberRequestRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TenantMemberRequestRejected";
  }
}

export interface ExecuteTenantMemberRequestOptions {
  /**
   * Whether the requester may still change this tenant's team. Defaults to
   * holding at least one role in the tenant's organization.
   */
  isRequesterAllowed?: (
    backend: TenantMembersBackend,
    tenantId: string,
    userId: string,
  ) => Promise<boolean>;
}

const holdsATeamRole: NonNullable<
  ExecuteTenantMemberRequestOptions["isRequesterAllowed"]
> = async (backend, tenantId, userId) => {
  try {
    return (await backend.listMemberRoles(tenantId, userId)).length > 0;
  } catch (err) {
    if (err instanceof TenantMembersNotFoundError) return false;
    throw err;
  }
};

/**
 * Carries out one request against the control-plane team of its tenant.
 *
 * `tenantId` is the tenant the caller proved it speaks for (the verified
 * service token's `tenant_id`); a request that names another tenant is
 * refused. The requester is checked again here because the request may have
 * waited a while. Running it twice is safe: membership and role changes are
 * idempotent, and an invitation that was already created for the same address
 * is reused instead of created again.
 *
 * Returns what the request produced, to store on the row. Throws
 * {@link TenantMemberRequestRejected} when it must not or cannot run.
 */
export async function executeTenantMemberRequest(
  backend: TenantMembersBackend,
  tenantId: string,
  request: Pick<
    TenantMemberRequest,
    "tenant_id" | "kind" | "requested_by" | "payload" | "result"
  >,
  options: ExecuteTenantMemberRequestOptions = {},
): Promise<Record<string, unknown> | null> {
  if (request.tenant_id !== tenantId) {
    throw new TenantMemberRequestRejected(
      "The request belongs to a different tenant",
    );
  }

  const allowed = options.isRequesterAllowed ?? holdsATeamRole;
  if (!(await allowed(backend, tenantId, request.requested_by))) {
    throw new TenantMemberRequestRejected(
      "The requester is no longer an administrator of this tenant",
    );
  }

  const parsed = tenantMemberRequestPayloadSchemas[request.kind].safeParse(
    request.payload,
  );
  if (!parsed.success) {
    throw new TenantMemberRequestRejected("The request payload is not valid");
  }

  try {
    switch (request.kind) {
      case "invite": {
        const input = tenantMemberRequestPayloadSchemas.invite.parse(
          request.payload,
        );
        const email = input.invitee.email.toLowerCase();
        const existing = (await backend.listInvitations(tenantId)).find(
          (invite) => invite.invitee?.email?.toLowerCase() === email,
        );
        if (existing) return { invitation_id: existing.id };
        const invite = await backend.createInvitation(tenantId, input);
        return { invitation_id: invite.id };
      }
      case "add_members":
        await backend.addMembers(
          tenantId,
          tenantMemberRequestPayloadSchemas.add_members.parse(request.payload)
            .user_ids,
        );
        return null;
      case "remove_members":
        await backend.removeMembers(
          tenantId,
          tenantMemberRequestPayloadSchemas.remove_members.parse(
            request.payload,
          ).user_ids,
        );
        return null;
      case "assign_roles": {
        const { user_id, roles } =
          tenantMemberRequestPayloadSchemas.assign_roles.parse(request.payload);
        await backend.assignMemberRoles(tenantId, user_id, roles);
        return null;
      }
      case "remove_roles": {
        const { user_id, roles } =
          tenantMemberRequestPayloadSchemas.remove_roles.parse(request.payload);
        await backend.removeMemberRoles(tenantId, user_id, roles);
        return null;
      }
      case "revoke_invitation": {
        const { invitation_id } =
          tenantMemberRequestPayloadSchemas.revoke_invitation.parse(
            request.payload,
          );
        try {
          await backend.revokeInvitation(tenantId, invitation_id);
        } catch (err) {
          // Already gone: the request has what it wanted. A missing team is
          // not that, and is reported below.
          if (!(err instanceof TenantInvitationNotFoundError)) throw err;
        }
        return null;
      }
    }
  } catch (err) {
    if (err instanceof TenantMembersNotFoundError) {
      throw new TenantMemberRequestRejected(
        "The tenant has no team on the control plane",
      );
    }
    throw err;
  }
}
