import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  conflict,
  managementValidationHook,
  notFound,
} from "../../errors/management-api-error";
import { isUniqueConstraintError } from "../../errors/is-unique-constraint-error";
import { Context } from "hono";
import { Bindings, Variables } from "../../types";
import { HTTPException } from "hono/http-exception";
import { querySchema } from "../../types";
import {
  resourceServerInsertSchema,
  resourceServerSchema,
  ResourceServer,
  LogTypes,
  escapeLuceneValue,
  DataAdapters,
} from "@authhero/adapter-interfaces";
import { parseSort } from "../../utils/sort";
import { logMessage } from "../../helpers/logging";

import { defineRoute } from "../../utils/define-route";
import {
  requireTenantId,
  withTotals,
  listResponse,
  findInPagedList,
} from "./helpers";
const resourceServersWithTotalsSchema = withTotals({
  resource_servers: z.array(resourceServerSchema),
});

// Checkpoint (keyset) pagination response: items plus an opaque cursor.
const resourceServersWithNextSchema = z.object({
  resource_servers: z.array(resourceServerSchema),
  next: z.string().optional().openapi({
    description: "Opaque cursor for the next page; absent on the last page.",
  }),
});

// Exact identifier lookup across every page. The `identifier:` filter narrows
// the scan but is a substring match in drizzle, so the comparison is redone
// here.
async function findResourceServerByIdentifier(
  data: DataAdapters,
  tenantId: string,
  identifier: string,
): Promise<ResourceServer | undefined> {
  return findInPagedList(
    async (page, per_page) =>
      (
        await data.resourceServers.list(tenantId, {
          q: `identifier:${escapeLuceneValue(identifier)}`,
          page,
          per_page,
        })
      ).resource_servers,
    (rs) => rs.identifier === identifier,
  );
}

// Auth0 lets clients reference a resource server by either its UUID id or its
// URL identifier. SDKs (e.g. terraform-provider-auth0) commonly pass the
// identifier. Look up by id first; on miss, look up by identifier.
async function resolveResourceServer(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
  idOrIdentifier: string,
): Promise<ResourceServer | null> {
  const direct = await ctx.env.data.resourceServers.get(
    tenantId,
    idOrIdentifier,
  );
  if (direct) return direct;
  return (
    (await findResourceServerByIdentifier(
      ctx.env.data,
      tenantId,
      idOrIdentifier,
    )) ?? null
  );
}
const getRoot = defineRoute({
  route: createRoute({
    tags: ["resource-servers"],
    method: "get",
    path: "/",
    request: {
      query: querySchema,
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },

    security: [
      {
        Bearer: ["read:resource_servers"],
      },
    ],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.union([
              z.array(resourceServerSchema),
              resourceServersWithTotalsSchema,
              resourceServersWithNextSchema,
            ]),
          },
        },
        description: "List of resource servers",
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

    const result = await ctx.env.data.resourceServers.list(tenant_id, {
      page,
      per_page,
      include_totals,
      sort: parseSort(sort),
      q,
      from,
      take,
    });

    // Keyset (checkpoint) pagination: return Auth0's { items, next } shape so
    // callers can walk past the first page with the opaque cursor. The offset
    // mode below (page/per_page + include_totals) is untouched.
    if (from !== undefined || take !== undefined) {
      return ctx.json({
        resource_servers: result.resource_servers,
        next: result.next,
      });
    }

    return ctx.json(listResponse(include_totals, result, "resource_servers"));
  },
});

const getById = defineRoute({
  route: createRoute({
    tags: ["resource-servers"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({
        id: z.string(),
      }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },

    security: [
      {
        Bearer: ["read:resource_servers"],
      },
    ],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: resourceServerSchema,
          },
        },
        description: "A resource server",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");

    const resourceServer = await resolveResourceServer(ctx, tenant_id, id);

    if (!resourceServer) {
      throw notFound.resourceServer();
    }

    return ctx.json(resourceServer);
  },
});

const deleteById = defineRoute({
  route: createRoute({
    tags: ["resource-servers"],
    method: "delete",
    path: "/{id}",
    request: {
      params: z.object({
        id: z.string(),
      }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["delete:resource_servers"],
      },
    ],
    responses: {
      200: {
        description: "Status",
      },
      204: {
        description: "The resource server does not exist",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");

    const resourceServer = await resolveResourceServer(ctx, tenant_id, id);

    // Auth0 answers 204 for deleting a resource server that doesn't exist.
    if (!resourceServer) {
      return ctx.body(null, 204);
    }

    if (resourceServer.is_system) {
      throw new HTTPException(403, {
        message: "System entities cannot be deleted",
      });
    }

    const tenant = await ctx.env.data.tenants.get(tenant_id);
    if (tenant?.default_audience === resourceServer.identifier) {
      throw conflict.other(
        "Resource server is set as the tenant's default_audience; clear it before deleting",
      );
    }

    await ctx.env.data.resourceServers.remove(tenant_id, resourceServer.id!);

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Delete a Resource Server",
      targetType: "resource_server",
      targetId: resourceServer.id!,
      beforeState: resourceServer as unknown as Record<string, unknown>,
    });

    return ctx.text("OK");
  },
});

const patchById = defineRoute({
  route: createRoute({
    tags: ["resource-servers"],
    method: "patch",
    path: "/{id}",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object(resourceServerInsertSchema.shape).partial(),
          },
        },
      },
      params: z.object({
        id: z.string(),
      }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["update:resource_servers"],
      },
    ],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: resourceServerSchema,
          },
        },
        description: "The updated resource server",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json");

    const existingResourceServer = await resolveResourceServer(
      ctx,
      tenant_id,
      id,
    );

    if (!existingResourceServer) {
      throw notFound.resourceServer();
    }

    if (existingResourceServer.is_system) {
      throw new HTTPException(403, {
        message: "System entities cannot be modified",
      });
    }

    const realId = existingResourceServer.id!;

    const newIdentifier = body.identifier;
    if (
      newIdentifier !== undefined &&
      newIdentifier !== existingResourceServer.identifier
    ) {
      const clash = await findResourceServerByIdentifier(
        ctx.env.data,
        tenant_id,
        newIdentifier,
      );
      if (clash && clash.id !== realId) {
        throw conflict.resourceServer(newIdentifier);
      }
    }

    try {
      await ctx.env.data.resourceServers.update(tenant_id, realId, body);
    } catch (err) {
      // The (tenant_id, identifier) unique index is the only one an update
      // can trip: a concurrent request took the identifier after the check.
      if (isUniqueConstraintError(err) && newIdentifier !== undefined) {
        throw conflict.resourceServer(newIdentifier);
      }
      throw err;
    }

    const resourceServer = await ctx.env.data.resourceServers.get(
      tenant_id,
      realId,
    );

    if (!resourceServer) {
      throw notFound.resourceServer();
    }

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Update a Resource Server",
      targetType: "resource_server",
      targetId: resourceServer.id!,
      beforeState: existingResourceServer as unknown as Record<string, unknown>,
      afterState: resourceServer as unknown as Record<string, unknown>,
    });

    return ctx.json(resourceServer);
  },
});

const postRoot = defineRoute({
  route: createRoute({
    tags: ["resource-servers"],
    method: "post",
    path: "/",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object(resourceServerInsertSchema.shape),
          },
        },
      },
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["create:resource_servers"],
      },
    ],
    responses: {
      201: {
        content: {
          "application/json": {
            schema: resourceServerSchema,
          },
        },
        description: "A resource server",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const body = ctx.req.valid("json");

    if (
      await findResourceServerByIdentifier(
        ctx.env.data,
        tenant_id,
        body.identifier,
      )
    ) {
      throw conflict.resourceServer(body.identifier);
    }

    let resourceServer: ResourceServer;
    try {
      resourceServer = await ctx.env.data.resourceServers.create(
        tenant_id,
        body,
      );
    } catch (err) {
      // A concurrent create took the identifier after the check above. Only
      // report it as an identifier conflict if that is what it was: a
      // caller-supplied `id` that already exists is a different 409.
      if (
        isUniqueConstraintError(err) &&
        (await findResourceServerByIdentifier(
          ctx.env.data,
          tenant_id,
          body.identifier,
        ))
      ) {
        throw conflict.resourceServer(body.identifier);
      }
      throw err;
    }

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Create a Resource Server",
      targetType: "resource_server",
      targetId: resourceServer.id,
      afterState: resourceServer as unknown as Record<string, unknown>,
    });

    return ctx.json(resourceServer, { status: 201 });
  },
});

export const resourceServerRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  getRoot,
  getById,
  deleteById,
  patchById,
  postRoot,
] as const);
