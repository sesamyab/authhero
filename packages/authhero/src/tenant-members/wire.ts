import { z } from "@hono/zod-openapi";
import { tenantInvitationInputSchema } from "./types";

/**
 * The HTTP contract shared by the control-plane `tenant-members` resource
 * (`createTenantMembersControlPlaneApp`) and the remote client that calls it
 * (`createControlPlaneTenantMembersAdapter`). Keeping the paths and body shapes
 * in one place is what keeps the two ends from drifting.
 */
export const CONTROL_PLANE_TENANT_MEMBERS_PATH =
  "/api/v2/proxy/control-plane/tenant-members";

/**
 * `tenant_id` rides on every write body for wire readability, but the server
 * NEVER acts on it: the tenant is taken from the verified token and a mismatch
 * is refused (same rule as the custom-domains resource). A shard holding the
 * scope must not touch another tenant's team by naming it.
 */
const tenantIdField = { tenant_id: z.string().optional() };

export const membersMutationBodySchema = z.object({
  ...tenantIdField,
  user_ids: z.array(z.string()).min(1),
});

export const memberRolesBodySchema = z.object({
  ...tenantIdField,
  roles: z.array(z.string()).min(1),
});

export const createInvitationBodySchema =
  tenantInvitationInputSchema.extend(tenantIdField);

/**
 * A shard tells the control plane that a team-change request is waiting
 * (issue #1550). Only the id travels: the control plane reads the request from
 * the shard, so what was asked never rests on what the notification claims.
 */
export const CONTROL_PLANE_TENANT_MEMBER_REQUESTS_NOTIFY_PATH = `${CONTROL_PLANE_TENANT_MEMBERS_PATH}/requests/notify`;

export const notifyMemberRequestBodySchema = z.object({
  ...tenantIdField,
  request_id: z.string().min(1),
});
