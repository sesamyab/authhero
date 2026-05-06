import { Bindings, Variables } from "../../types";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { emailProviderSchema, LogTypes } from "@authhero/adapter-interfaces";
import { logMessage } from "../../helpers/logging";
import { HTTPException } from "hono/http-exception";

export const emailProviderRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>()
  // --------------------------------
  // GET /api/v2/emails/provider
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["emails"],
      method: "get",
      path: "/",
      request: {
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
      },
      security: [
        {
          Bearer: ["read:emails", "auth:read"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: emailProviderSchema,
            },
          },
          description: "Email provider",
        },
      },
    }),
    async (ctx) => {
      const emailProvider = await ctx.env.data.emailProviders.get(
        ctx.var.tenant_id,
      );

      if (!emailProvider) {
        throw new HTTPException(404, { message: "Email provider not found" });
      }

      return ctx.json(emailProvider);
    },
  )
  // --------------------------------
  // POST /api/v2/emails/provider
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["emails"],
      method: "post",
      path: "/",
      request: {
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
        body: {
          content: {
            "application/json": {
              schema: z.object(emailProviderSchema.shape),
            },
          },
        },
      },
      security: [
        {
          Bearer: ["create:emails", "auth:write"],
        },
      ],
      responses: {
        200: {
          description: "Branding settings",
        },
      },
    }),
    async (ctx) => {
      const emailProvider = ctx.req.valid("json");

      // The email provider is a singleton per tenant. POST behaves as upsert
      // so SDK clients (and the existing test seed) don't hit unique-key
      // collisions when calling against an already-configured tenant.
      const existing = await ctx.env.data.emailProviders.get(
        ctx.var.tenant_id,
      );
      if (existing) {
        await ctx.env.data.emailProviders.update(
          ctx.var.tenant_id,
          emailProvider,
        );
      } else {
        await ctx.env.data.emailProviders.create(
          ctx.var.tenant_id,
          emailProvider,
        );
      }

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Create Email Provider",
        targetType: "email_provider",
        targetId: ctx.var.tenant_id,
      });

      const stored = await ctx.env.data.emailProviders.get(ctx.var.tenant_id);
      return ctx.json(stored ?? emailProvider, { status: 201 });
    },
  )
  // --------------------------------
  // PATCH /api/v2/emails/provider
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["emails"],
      method: "patch",
      path: "/",
      request: {
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
        body: {
          content: {
            "application/json": {
              schema: z.object(emailProviderSchema.shape).partial(),
            },
          },
        },
      },
      security: [
        {
          Bearer: ["update:emails", "auth:write"],
        },
      ],
      responses: {
        200: {
          description: "Branding settings",
        },
      },
    }),
    async (ctx) => {
      const patch = ctx.req.valid("json");

      await ctx.env.data.emailProviders.update(ctx.var.tenant_id, patch);

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Update Email Provider",
        targetType: "email_provider",
        targetId: ctx.var.tenant_id,
      });

      const updated = await ctx.env.data.emailProviders.get(ctx.var.tenant_id);
      return ctx.json(updated ?? patch);
    },
  );
