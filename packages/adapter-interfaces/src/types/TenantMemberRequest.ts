import { z } from "@hono/zod-openapi";

/**
 * A change to a tenant's team that a WFP shard registers and the control plane
 * carries out (issue #1550). The row lives in the shard's own database, so the
 * shard keeps a record of what was asked, and the control plane writes the
 * outcome back to it.
 */
export const tenantMemberRequestKindSchema = z.enum([
  "invite",
  "add_members",
  "remove_members",
  "assign_roles",
  "remove_roles",
  "revoke_invitation",
]);
export type TenantMemberRequestKind = z.infer<
  typeof tenantMemberRequestKindSchema
>;

export const tenantMemberRequestStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
]);
export type TenantMemberRequestStatus = z.infer<
  typeof tenantMemberRequestStatusSchema
>;

export const tenantMemberRequestInsertSchema = z.object({
  kind: tenantMemberRequestKindSchema,
  /** The `sub` of the tenant admin who asked, as verified on the shard. */
  requested_by: z.string().min(1).max(255),
  /** What to do, per kind. Holds emails, so it is never copied to an operation. */
  payload: z.record(z.string(), z.unknown()),
});
export type TenantMemberRequestInsert = z.input<
  typeof tenantMemberRequestInsertSchema
>;

export const tenantMemberRequestSchema = tenantMemberRequestInsertSchema.extend(
  {
    id: z.string(),
    tenant_id: z.string(),
    status: tenantMemberRequestStatusSchema,
    /** What the request produced, for example the id of a created invitation. */
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Why a `failed` request failed. A reason an admin may read, never a stack. */
    error: z.string().nullable().optional(),
    /** When the control plane acknowledged the request. Unset until it did. */
    notified_at: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    finished_at: z.string().nullable().optional(),
  },
);
export type TenantMemberRequest = z.infer<typeof tenantMemberRequestSchema>;

export const tenantMemberRequestUpdateSchema = z.object({
  status: tenantMemberRequestStatusSchema.optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  notified_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
});
export type TenantMemberRequestUpdate = z.infer<
  typeof tenantMemberRequestUpdateSchema
>;
