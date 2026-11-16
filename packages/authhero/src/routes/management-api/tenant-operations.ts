import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  managementValidationHook,
  notFound,
} from "../../errors/management-api-error";
import { HTTPException } from "hono/http-exception";
import {
  LogTypes,
  tenantOperationEventSchema,
  tenantOperationKindSchema,
  tenantOperationSchema,
  tenantOperationStatusSchema,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { defineRoute } from "../../utils/define-route";
import { logMessage } from "../../helpers/logging";
import { isControlPlaneTenant } from "./tenants";
import { scopeForms } from "../../middlewares/authentication";

// Durable tenant lifecycle operations (issue #1026). These are
// control-plane records: the routes are only mounted when the management
// adapter carries the tenantOperations/tenantOperationEvents adapters,
// which only control-plane deployments wire up.

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  kind: tenantOperationKindSchema.optional(),
  status: tenantOperationStatusSchema.optional(),
  rollout_id: z.string().optional(),
});

type CallerToken = {
  sub?: string;
  azp?: string;
  gty?: string;
  scope?: string | string[];
  permissions?: string[];
  org_id?: string;
  tenant_id?: string;
};

/**
 * What the token grants, read the way the authentication middleware reads it:
 * `scope` may be a space-separated string or an array, and each grant counts
 * in both spellings (`create:tenant_operations` and `tenant_operations:create`).
 */
function callerGrants(user: CallerToken | undefined): Set<string> {
  const scopes =
    typeof user?.scope === "string"
      ? user.scope.split(" ").filter(Boolean)
      : Array.isArray(user?.scope)
        ? user.scope
        : [];
  return new Set([...(user?.permissions ?? []), ...scopes].flatMap(scopeForms));
}

/**
 * Whether the caller may reach a tenant's operations.
 *
 * - A caller whose token belongs to a child tenant reaches only that tenant.
 *   The tenant is the token's `tenant_id`, not the `tenant-id` header, which
 *   a control-plane token may point at any tenant. A token without a
 *   `tenant_id` is not a child's token and is treated like a control-plane one.
 * - On the control plane, an operator reaches every tenant: a machine token
 *   (its scopes are explicit grants), a caller holding `create:tenant_operations` or
 *   `create:rollouts`,
 *   or a user token that is not scoped to an organization and holds
 *   `admin:organizations`. Anyone else reaches only the
 *   tenants whose organization they belong to, the same rule as `GET /tenants`.
 * - Without a configured control plane there is one tenant and no filter.
 */
async function callerReachesTenant(
  ctx: {
    env: { data: Bindings["data"] };
    var: Variables;
  },
  targetTenantId: string | null,
): Promise<boolean> {
  const controlPlaneTenantId =
    ctx.env.data.multiTenancyConfig?.controlPlaneTenantId;
  if (!controlPlaneTenantId) return true;

  const user = ctx.var.user as CallerToken | undefined;
  // Which tenant the caller belongs to is the token's own `tenant_id`, never
  // the `tenant-id` header: a control-plane token may name any tenant there,
  // and the header is the caller's to set. A token that does not say which
  // tenant it belongs to is not a child's token either, so it gets no
  // own-tenant shortcut and goes through the operator and membership rules.
  if (user?.tenant_id && user.tenant_id !== controlPlaneTenantId) {
    return targetTenantId === user.tenant_id;
  }
  if (!user?.sub) return false;
  if (
    user.sub.endsWith("@clients") ||
    (user.azp && user.sub === user.azp) ||
    user.gty
  ) {
    return true;
  }
  const grants = callerGrants(user);
  // Operator scopes: `create:tenant_operations` starts any kind of operation
  // and `create:rollouts` runs one across the fleet, so their holders already
  // reach every tenant.
  if (grants.has("create:tenant_operations") || grants.has("create:rollouts")) {
    return true;
  }
  const orgScoped = Boolean(user.org_id ?? ctx.var.organization_id);
  if (!orgScoped && grants.has("admin:organizations")) return true;

  // An operation with no tenant (fleet-wide) is for operators only.
  if (!targetTenantId) return false;

  const perPage = 100;
  for (let page = 0; ; page++) {
    const { organizations } =
      await ctx.env.data.userOrganizations.listUserOrganizations(
        controlPlaneTenantId,
        user.sub,
        { page, per_page: perPage },
      );
    if (
      organizations.some(
        (org) => org.name.toLowerCase() === targetTenantId.toLowerCase(),
      )
    ) {
      return true;
    }
    if (organizations.length < perPage) return false;
  }
}

// GET /operations/{id} — one operation plus its full event timeline.
const getOperation = defineRoute({
  route: createRoute({
    tags: ["tenant-operations"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:tenant_operations"] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: tenantOperationSchema.extend({
              events: z.array(tenantOperationEventSchema),
            }),
          },
        },
        description: "The operation with its step events",
      },
    },
  }),
  handler: async (ctx) => {
    const { tenantOperations, tenantOperationEvents } = ctx.env.data;
    if (!tenantOperations || !tenantOperationEvents) {
      throw new HTTPException(501, {
        message: "Tenant operations are not configured for this deployment",
      });
    }

    const { id } = ctx.req.valid("param");
    const operation = await tenantOperations.get(id);
    // Only operators on the control plane may read arbitrary operations;
    // other callers are limited to the tenants they can reach. Respond 404
    // (not 403) so foreign operation ids don't leak their existence.
    if (!operation || !(await callerReachesTenant(ctx, operation.tenant_id))) {
      throw notFound.tenantOperation();
    }

    const { events } = await tenantOperationEvents.listByOperation(id);
    return ctx.json({ ...operation, events });
  },
});

export const operationRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  getOperation,
] as const);

// GET /tenants/:id/operations — paginated history for one tenant. The
// target tenant id comes from the mount path (like
// /users/:user_id/authentication-methods).
const listTenantOperations = defineRoute({
  route: createRoute({
    tags: ["tenant-operations"],
    method: "get",
    path: "/",
    request: {
      query: listQuerySchema,
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:tenant_operations"] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              operations: z.array(tenantOperationSchema),
              start: z.number(),
              limit: z.number(),
              length: z.number(),
            }),
          },
        },
        description: "Operations for the tenant, newest first",
      },
    },
  }),
  handler: async (ctx) => {
    const { tenantOperations } = ctx.env.data;
    if (!tenantOperations) {
      throw new HTTPException(501, {
        message: "Tenant operations are not configured for this deployment",
      });
    }

    const tenantId = ctx.req.param("id");
    if (!tenantId) {
      throw new HTTPException(400, { message: "Missing tenant id" });
    }
    // Same scoping as GET /operations/{id}: a child tenant reads only its own
    // history, and on the control plane only operators and members of the
    // tenant's organization read a tenant's history.
    if (
      !isControlPlaneTenant(ctx, ctx.var.tenant_id) &&
      tenantId !== ctx.var.tenant_id
    ) {
      throw new HTTPException(403, {
        message:
          "Operations for other tenants can only be read from the control plane",
      });
    }
    if (!(await callerReachesTenant(ctx, tenantId))) {
      throw notFound.tenant();
    }
    const { page, per_page, kind, status, rollout_id } = ctx.req.valid("query");

    const result = await tenantOperations.list({
      tenant_id: tenantId,
      page,
      per_page,
      kind,
      status,
      rollout_id,
    });

    return ctx.json(result);
  },
});

// POST /tenants/:id/operations — enqueue an operation for a tenant.
// Control-plane only, mirroring POST /tenants/{id}/redeploy. Phase 1
// supports { kind: "upgrade" } via the configured executor; provision and
// deprovision stay lifecycle-hook driven, seed and backup arrive with the
// durable executor phases.
const createTenantOperation = defineRoute({
  route: createRoute({
    tags: ["tenant-operations"],
    method: "post",
    path: "/",
    request: {
      headers: z.object({ "tenant-id": z.string().optional() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              kind: tenantOperationKindSchema,
              // Kind-specific parameters. Only `sync-defaults` and `detach` take any.
              input: z
                .object({
                  dry_run: z.boolean().optional(),
                  force: z.boolean().optional(),
                  prune: z.boolean().optional(),
                  clean: z.boolean().optional(),
                })
                .optional(),
            }),
          },
        },
      },
    },
    // `retry:tenant_provisioning` is the narrow scope for self-service users:
    // it only allows retrying a failed provision (see the handler).
    security: [
      { Bearer: ["create:tenant_operations", "retry:tenant_provisioning"] },
    ],
    responses: {
      201: {
        content: {
          "application/json": { schema: tenantOperationSchema },
        },
        description:
          "The enqueued operation. Poll GET /operations/{id} for progress; the inline engine returns it already terminal.",
      },
    },
  }),
  handler: async (ctx) => {
    if (!isControlPlaneTenant(ctx, ctx.var.tenant_id)) {
      throw new HTTPException(403, {
        message:
          "Tenant operations can only be triggered from the control plane",
      });
    }

    const { kind, input } = ctx.req.valid("json");
    const tenantId = ctx.req.param("id");
    if (!tenantId) {
      throw new HTTPException(400, { message: "Missing tenant id" });
    }

    const tenant = await ctx.env.data.tenants.get(tenantId);
    if (!tenant) {
      throw notFound.tenant();
    }
    if (!(await callerReachesTenant(ctx, tenantId))) {
      throw notFound.tenant();
    }

    // Without `create:tenant_operations` the caller holds only the narrow
    // retry scope: `upgrade`, and only while the tenant's provisioning failed.
    if (
      !callerGrants(ctx.var.user as CallerToken).has("create:tenant_operations")
    ) {
      if (kind !== "upgrade" || tenant.provisioning_state !== "failed") {
        throw new HTTPException(403, {
          message:
            "retry:tenant_provisioning only allows retrying a failed provision",
        });
      }
    }

    if (kind === "provision" || kind === "deprovision") {
      throw new HTTPException(400, {
        message: `Operations of kind "${kind}" are managed by the tenant lifecycle (create/delete) and cannot be enqueued directly`,
      });
    }

    if (kind === "seed" || kind === "backup") {
      throw new HTTPException(501, {
        message: `Operations of kind "${kind}" are not supported yet`,
      });
    }

    if (input && kind !== "sync-defaults" && kind !== "detach") {
      throw new HTTPException(400, {
        message: `Operations of kind "${kind}" take no input`,
      });
    }

    const executor = ctx.env.tenantOperationExecutor;
    if (!executor) {
      throw new HTTPException(501, {
        message:
          "Tenant operations are not configured for this deployment (no executor)",
      });
    }
    if (executor.kinds && !executor.kinds.includes(kind)) {
      throw new HTTPException(501, {
        message: `Operations of kind "${kind}" are not configured for this deployment`,
      });
    }

    const operation = await executor.enqueue({
      kind,
      tenant_id: tenantId,
      initiated_by: ctx.var.user?.sub,
      ...(input ? { input } : {}),
    });

    await logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: `Enqueue tenant operation (${kind})`,
      targetType: "tenant",
      targetId: tenantId,
    });

    return ctx.json(operation, { status: 201 });
  },
});

export const tenantOperationsRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  listTenantOperations,
  createTenantOperation,
] as const);
