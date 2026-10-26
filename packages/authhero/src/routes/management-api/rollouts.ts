import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  LogTypes,
  rolloutKindSchema,
  rolloutSchema,
  rolloutStatusSchema,
  type TenantOperationsAdapter,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { defineRoute } from "../../utils/define-route";
import { logMessage } from "../../helpers/logging";
import { isControlPlaneTenant } from "./tenants";

// Fleet rollouts of synced config (issue #1499). Control-plane records like
// tenant operations: they are only mounted when the management adapter carries
// the rollouts and tenantOperations adapters, and every route is control-plane
// only. Progress is derived from the `sync-defaults` operations that carry the
// rollout's id.

const requireControlPlane = (
  ctx: Parameters<typeof isControlPlaneTenant>[0] & {
    var: { tenant_id: string };
  },
) => {
  if (!isControlPlaneTenant(ctx, ctx.var.tenant_id)) {
    throw new HTTPException(403, {
      message: "Rollouts can only be managed from the control plane",
    });
  }
};

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  kind: rolloutKindSchema.optional(),
  status: rolloutStatusSchema.optional(),
});

const summarySchema = z.object({
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_wave: z.array(
    z.object({
      wave: z.number(),
      total: z.number(),
      by_status: z.record(z.string(), z.number()),
    }),
  ),
});

const rolloutWithSummarySchema = rolloutSchema.extend({
  summary: summarySchema,
});

async function summarize(
  tenantOperations: TenantOperationsAdapter,
  rolloutId: string,
) {
  const byStatus: Record<string, number> = {};
  const waves = new Map<number, Record<string, number>>();
  let total = 0;
  const perPage = 200;
  for (let page = 0; ; page++) {
    const { operations } = await tenantOperations.list({
      rollout_id: rolloutId,
      page,
      per_page: perPage,
    });
    for (const operation of operations) {
      total++;
      byStatus[operation.status] = (byStatus[operation.status] ?? 0) + 1;
      const wave =
        typeof (operation.input as { wave?: unknown } | null)?.wave === "number"
          ? (operation.input as { wave: number }).wave
          : 0;
      const counts = waves.get(wave) ?? {};
      counts[operation.status] = (counts[operation.status] ?? 0) + 1;
      waves.set(wave, counts);
    }
    if (operations.length < perPage) break;
  }
  return {
    total,
    by_status: byStatus,
    by_wave: [...waves.entries()]
      .sort(([a], [b]) => a - b)
      .map(([wave, counts]) => ({
        wave,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        by_status: counts,
      })),
  };
}

const listRollouts = defineRoute({
  route: createRoute({
    tags: ["rollouts"],
    method: "get",
    path: "/",
    request: {
      query: listQuerySchema,
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:rollouts"] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              rollouts: z.array(rolloutSchema),
              start: z.number(),
              limit: z.number(),
              length: z.number(),
            }),
          },
        },
        description: "Rollouts, newest first",
      },
    },
  }),
  handler: async (ctx) => {
    requireControlPlane(ctx);
    const { rollouts } = ctx.env.data;
    if (!rollouts) {
      throw new HTTPException(501, {
        message: "Rollouts are not configured for this deployment",
      });
    }
    const { page, per_page, kind, status } = ctx.req.valid("query");
    return ctx.json(await rollouts.list({ page, per_page, kind, status }));
  },
});

const getRollout = defineRoute({
  route: createRoute({
    tags: ["rollouts"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:rollouts"] }],
    responses: {
      200: {
        content: {
          "application/json": { schema: rolloutWithSummarySchema },
        },
        description:
          "The rollout with per-status and per-wave operation counts",
      },
      404: { description: "Rollout not found" },
    },
  }),
  handler: async (ctx) => {
    requireControlPlane(ctx);
    const { rollouts, tenantOperations } = ctx.env.data;
    if (!rollouts || !tenantOperations) {
      throw new HTTPException(501, {
        message: "Rollouts are not configured for this deployment",
      });
    }
    const { id } = ctx.req.valid("param");
    const rollout = await rollouts.get(id);
    if (!rollout)
      throw new HTTPException(404, { message: "Rollout not found" });
    return ctx.json({
      ...rollout,
      summary: await summarize(tenantOperations, id),
    });
  },
});

const createRollout = defineRoute({
  route: createRoute({
    tags: ["rollouts"],
    method: "post",
    path: "/",
    request: {
      headers: z.object({ "tenant-id": z.string().optional() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              /** Roll out to the synced descendants of this tenant. Defaults to the control plane. */
              root_tenant_id: z.string().optional(),
              /** Limit the rollout to these tenants. */
              tenant_ids: z.array(z.string()).max(10_000).optional(),
              /** Tenants synced first, on their own. */
              canary: z.number().int().min(0).max(1000).optional(),
              /** Cumulative percentages of the rest, ascending, for example [10, 50, 100]. */
              waves: z
                .array(z.number().int().min(1).max(100))
                .min(1)
                .max(20)
                .refine(
                  (waves) =>
                    waves.every((w, i) => i === 0 || w > waves[i - 1]!),
                  { message: "waves must be ascending" },
                )
                .optional(),
              /** Failed fraction of a wave (0..1) above which the rollout pauses. */
              failure_threshold: z.number().min(0).max(1).optional(),
              /** Operations started per tick. */
              max_concurrent: z.number().int().min(1).max(500).optional(),
              dry_run: z.boolean().optional(),
              force: z.boolean().optional(),
            }),
          },
        },
      },
    },
    security: [{ Bearer: ["create:rollouts"] }],
    responses: {
      201: {
        content: { "application/json": { schema: rolloutSchema } },
        description:
          "The planned rollout. Its canary has started; later waves start as the rollout is advanced.",
      },
    },
  }),
  handler: async (ctx) => {
    requireControlPlane(ctx);
    const controller = ctx.env.rolloutController;
    if (!controller) {
      throw new HTTPException(501, {
        message:
          "Rollouts are not configured for this deployment (no controller)",
      });
    }
    const body = ctx.req.valid("json");
    const rollout = await controller.create({
      rootTenantId: body.root_tenant_id,
      tenantIds: body.tenant_ids,
      canary: body.canary,
      waves: body.waves,
      failureThreshold: body.failure_threshold,
      maxConcurrent: body.max_concurrent,
      dryRun: body.dry_run,
      force: body.force,
      initiatedBy: ctx.var.user?.sub,
    });

    await logMessage(ctx, ctx.var.tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: `Create rollout (${rollout.id})`,
      targetType: "rollout",
      targetId: rollout.id,
    });
    return ctx.json(rollout, 201);
  },
});

const pauseRollout = defineRoute({
  route: createRoute({
    tags: ["rollouts"],
    method: "post",
    path: "/{id}/pause",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ reason: z.string().max(500).optional() }),
          },
        },
        required: false,
      },
    },
    security: [{ Bearer: ["update:rollouts"] }],
    responses: {
      200: {
        content: { "application/json": { schema: rolloutSchema } },
        description:
          "The paused rollout. Nothing further starts until it is resumed.",
      },
      404: { description: "Rollout not found" },
    },
  }),
  handler: async (ctx) => {
    requireControlPlane(ctx);
    const controller = ctx.env.rolloutController;
    if (!controller) {
      throw new HTTPException(501, {
        message:
          "Rollouts are not configured for this deployment (no controller)",
      });
    }
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json") as { reason?: string } | undefined;
    const rollout = await controller.pause(id, body?.reason);
    if (!rollout)
      throw new HTTPException(404, { message: "Rollout not found" });
    return ctx.json(rollout);
  },
});

const resumeRollout = defineRoute({
  route: createRoute({
    tags: ["rollouts"],
    method: "post",
    path: "/{id}/resume",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["update:rollouts"] }],
    responses: {
      200: {
        content: { "application/json": { schema: rolloutSchema } },
        description:
          "The resumed rollout. The failures that paused it are accepted and the next wave starts on the next tick.",
      },
      404: { description: "Rollout not found" },
    },
  }),
  handler: async (ctx) => {
    requireControlPlane(ctx);
    const controller = ctx.env.rolloutController;
    if (!controller) {
      throw new HTTPException(501, {
        message:
          "Rollouts are not configured for this deployment (no controller)",
      });
    }
    const { id } = ctx.req.valid("param");
    const rollout = await controller.resume(id);
    if (!rollout)
      throw new HTTPException(404, { message: "Rollout not found" });
    return ctx.json(rollout);
  },
});

export const rolloutRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([
  listRollouts,
  getRollout,
  createRollout,
  pauseRollout,
  resumeRollout,
] as const);
