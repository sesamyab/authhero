import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  notFound,
  managementValidationHook,
} from "../../errors/management-api-error";
import { Bindings, Variables } from "../../types";
import { querySchema } from "../../types";
import {
  formInsertSchema,
  formSchema,
  LogTypes,
} from "@authhero/adapter-interfaces";
import { logMessage } from "../../helpers/logging";
import { parseSort } from "../../utils/sort";
import { defineRoute } from "../../utils/define-route";
import { requireTenantId, withTotals, withNext, listResponse } from "./helpers";

const formsWithTotalsSchema = withTotals({
  forms: z.array(formSchema),
});

const formsWithNextSchema = withNext({
  forms: z.array(formSchema),
});

// GET /api/v2/forms
const listForms = defineRoute({
  route: createRoute({
    tags: ["forms"],
    method: "get",
    path: "/",
    request: {
      query: querySchema,
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [{ Bearer: ["read:forms"] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.union([
              z.array(formSchema),
              formsWithTotalsSchema,
              formsWithNextSchema,
            ]),
          },
        },
        description: "List of forms",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const {
      page,
      per_page,
      include_totals = false,
      sort,
      q,
      from,
      take,
    } = ctx.req.valid("query");
    const result = await ctx.env.data.forms.list(tenant_id, {
      page,
      per_page,
      include_totals,
      sort: parseSort(sort),
      q,
      from,
      take,
    });
    // Checkpoint (from/take): { forms, next }. Checkpoint is an authhero
    // extension here; Auth0 pages this endpoint by offset only.
    if (from !== undefined || take !== undefined) {
      return ctx.json({ forms: result.forms, next: result.next });
    }

    return ctx.json(listResponse(include_totals, result, "forms"));
  },
});

// GET /api/v2/forms/:id
const getForm = defineRoute({
  route: createRoute({
    tags: ["forms"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:forms"] }],
    responses: {
      200: {
        content: { "application/json": { schema: formSchema } },
        description: "A form",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const form = await ctx.env.data.forms.get(tenant_id, id);
    if (!form) {
      throw notFound.form();
    }
    return ctx.json(form);
  },
});

// DELETE /api/v2/forms/:id
const deleteForm = defineRoute({
  route: createRoute({
    tags: ["forms"],
    method: "delete",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["delete:forms"] }],
    responses: {
      200: { description: "Status" },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const existing = await ctx.env.data.forms.get(tenant_id, id);
    const result = await ctx.env.data.forms.remove(tenant_id, id);
    if (!result) {
      throw notFound.form();
    }

    // A delete has no after state — consumers fall back to `before`.
    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Delete a Form",
      targetType: "form",
      targetId: id,
      ...(existing ? { beforeState: { ...existing } } : {}),
    });

    return ctx.text("OK");
  },
});

// PATCH /api/v2/forms/:id
const patchForm = defineRoute({
  route: createRoute({
    tags: ["forms"],
    method: "patch",
    path: "/{id}",
    request: {
      body: {
        content: {
          "application/json": {
            schema: formInsertSchema.partial(),
          },
        },
      },
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["update:forms"] }],
    responses: {
      200: {
        content: { "application/json": { schema: formSchema } },
        description: "The updated form",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json");
    const existing = await ctx.env.data.forms.get(tenant_id, id);
    const result = await ctx.env.data.forms.update(tenant_id, id, body);
    if (!result) {
      throw notFound.form();
    }
    const form = await ctx.env.data.forms.get(tenant_id, id);
    if (!form) {
      throw notFound.form();
    }

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Update a Form",
      targetType: "form",
      targetId: id,
      ...(existing ? { beforeState: { ...existing } } : {}),
      afterState: form as Record<string, unknown>,
    });

    return ctx.json(form);
  },
});

// POST /api/v2/forms
const createForm = defineRoute({
  route: createRoute({
    tags: ["forms"],
    method: "post",
    path: "/",
    request: {
      body: {
        content: {
          "application/json": {
            schema: formInsertSchema,
          },
        },
      },
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["create:forms"] }],
    responses: {
      201: {
        content: { "application/json": { schema: formSchema } },
        description: "A form",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const body = ctx.req.valid("json");
    const form = await ctx.env.data.forms.create(tenant_id, body);

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Create a Form",
      targetType: "form",
      targetId: form.id,
      afterState: form as Record<string, unknown>,
    });

    return ctx.json(form, { status: 201 });
  },
});

export const formsRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  listForms,
  getForm,
  deleteForm,
  patchForm,
  createForm,
] as const);
