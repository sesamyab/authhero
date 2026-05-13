import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Bindings, Variables } from "../../types";
import { HTTPException } from "hono/http-exception";
import { logMessage } from "../../helpers/logging";
import { querySchema } from "../../types";
import {
  Connection,
  connectionInsertSchema,
  connectionSchema,
  totalsSchema,
  LogTypes,
} from "@authhero/adapter-interfaces";
import { parseSort } from "../../utils/sort";
import { generateConnectionId } from "../../utils/entity-id";

const connectionsWithTotalsSchema = totalsSchema.extend({
  connections: z.array(connectionSchema),
});

// Auth0 omits secret fields from connection responses — callers must POST/PATCH
// to set them, and a missing value means "keep existing". Mirror that contract.
const SECRET_OPTION_FIELDS = [
  "client_secret",
  "app_secret",
  "twilio_token",
] as const;

function stripConnectionSecrets(connection: Connection): Connection {
  if (!connection.options) return connection;
  const options = { ...connection.options };
  for (const field of SECRET_OPTION_FIELDS) {
    delete options[field];
  }
  return { ...connection, options };
}

// Schema for the connection clients response
const connectionClientsResponseSchema = z.object({
  enabled_clients: z.array(
    z.object({
      client_id: z.string(),
      name: z.string(),
    }),
  ),
});

// Schema for updating connection clients
const updateConnectionClientsSchema = z.array(
  z.object({
    client_id: z.string(),
    status: z.boolean(),
  }),
);

export const connectionRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>()
  // --------------------------------
  // GET /api/v2/connections
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
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
          Bearer: ["read:connections", "auth:read"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.union([
                z.array(connectionSchema),
                connectionsWithTotalsSchema,
              ]),
            },
          },
          description: "List of connectionss",
        },
      },
    }),
    async (ctx) => {
      const {
        page,
        per_page,
        include_totals = false,
        sort,
        q,
      } = ctx.req.valid("query");

      const result = await ctx.env.data.connections.list(ctx.var.tenant_id, {
        page,
        per_page,
        include_totals,
        sort: parseSort(sort),
        q,
      });

      const connections = result.connections.map(stripConnectionSecrets);

      if (!include_totals) {
        return ctx.json(connections);
      }

      return ctx.json({ ...result, connections });
    },
  )
  // --------------------------------
  // GET /api/v2/connections/:id
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
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
          Bearer: ["read:connections", "auth:read"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: connectionSchema,
            },
          },
          description: "A connection",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");

      const connection = await ctx.env.data.connections.get(
        ctx.var.tenant_id,
        id,
      );

      if (!connection) {
        throw new HTTPException(404);
      }

      return ctx.json(stripConnectionSecrets(connection));
    },
  )
  // --------------------------------
  // DELETE /api/v2/connections/:id
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
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
          Bearer: ["delete:connections", "auth:write"],
        },
      ],
      responses: {
        200: {
          description: "Status",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const tenantId = ctx.var.tenant_id;

      const result = await ctx.env.data.connections.remove(tenantId, id);
      if (!result) {
        throw new HTTPException(404, {
          message: "Connection not found",
        });
      }

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Delete a Connection",
        targetType: "connection",
        targetId: id,
      });

      return ctx.text("OK");
    },
  )
  // --------------------------------
  // PATCH /api/v2/connections/:id
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
      method: "patch",
      path: "/{id}",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object(connectionInsertSchema.shape).partial(),
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
          Bearer: ["update:connections", "auth:write"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: connectionSchema,
            },
          },
          description: "The updated connection",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      const tenantId = ctx.var.tenant_id;

      const connectionBefore = await ctx.env.data.connections.get(tenantId, id);

      // GET responses strip secrets, so a read→edit→PATCH round-trip would
      // otherwise wipe them. Preserve existing secret fields when the caller
      // didn't send a new value, matching Auth0's "missing = keep" contract.
      if (body.options && connectionBefore?.options) {
        for (const field of SECRET_OPTION_FIELDS) {
          if (
            body.options[field] === undefined &&
            connectionBefore.options[field] !== undefined
          ) {
            body.options[field] = connectionBefore.options[field];
          }
        }
      }

      const result = await ctx.env.data.connections.update(tenantId, id, body);
      if (!result) {
        throw new HTTPException(404, {
          message: "Connection not found",
        });
      }

      const connection = await ctx.env.data.connections.get(tenantId, id);

      if (!connection) {
        throw new HTTPException(404, {
          message: "Connection not found",
        });
      }

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Update a Connection",
        beforeState: connectionBefore as Record<string, unknown>,
        afterState: connection as Record<string, unknown>,
        targetType: "connection",
        targetId: id,
        body,
      });

      return ctx.json(stripConnectionSecrets(connection));
    },
  )
  // --------------------------------
  // POST /api/v2/connections
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
      method: "post",
      path: "/",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object(connectionInsertSchema.shape),
            },
          },
        },
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
      },
      security: [
        {
          Bearer: ["create:connections", "auth:write"],
        },
      ],
      responses: {
        201: {
          content: {
            "application/json": {
              schema: connectionSchema,
            },
          },
          description: "A connection",
        },
      },
    }),
    async (ctx) => {
      const body = ctx.req.valid("json");
      const tenantId = ctx.var.tenant_id;

      // Generate ID if not provided
      const connectionId = body.id || generateConnectionId();

      const connection = await ctx.env.data.connections.create(tenantId, {
        ...body,
        id: connectionId,
      });

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Create a Connection",
        afterState: connection as Record<string, unknown>,
        targetType: "connection",
        targetId: connection.id,
      });

      return ctx.json(stripConnectionSecrets(connection), { status: 201 });
    },
  )
  // --------------------------------
  // GET /api/v2/connections/:id/clients
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
      method: "get",
      path: "/{id}/clients",
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
          Bearer: ["read:connections", "auth:read"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: connectionClientsResponseSchema,
            },
          },
          description: "List of clients enabled for this connection",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");

      // First verify the connection exists
      const connection = await ctx.env.data.connections.get(
        ctx.var.tenant_id,
        id,
      );

      if (!connection) {
        throw new HTTPException(404, {
          message: "Connection not found",
        });
      }

      // Get all clients in this tenant
      const { clients } = await ctx.env.data.clients.list(ctx.var.tenant_id, {
        per_page: 1000,
      });

      // Filter to clients that have this connection enabled
      const enabledClients = clients
        .filter((client) => client.connections?.includes(id))
        .map((client) => ({
          client_id: client.client_id,
          name: client.name,
        }));

      return ctx.json({ enabled_clients: enabledClients });
    },
  )
  // --------------------------------
  // PATCH /api/v2/connections/:id/clients
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["connections"],
      method: "patch",
      path: "/{id}/clients",
      request: {
        body: {
          content: {
            "application/json": {
              schema: updateConnectionClientsSchema,
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
          Bearer: ["update:connections", "auth:write"],
        },
      ],
      responses: {
        204: {
          description: "Clients updated successfully (No Content)",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");

      // First verify the connection exists
      const connection = await ctx.env.data.connections.get(
        ctx.var.tenant_id,
        id,
      );

      if (!connection) {
        throw new HTTPException(404, {
          message: "Connection not found",
        });
      }

      // Process each client update; respond 204 to match Auth0's contract.
      for (const clientUpdate of body) {
        const client = await ctx.env.data.clients.get(
          ctx.var.tenant_id,
          clientUpdate.client_id,
        );

        if (!client) {
          continue; // Skip non-existent clients
        }

        const currentConnections = client.connections || [];

        if (clientUpdate.status) {
          // Enable: Add connection if not already present
          if (!currentConnections.includes(id)) {
            await ctx.env.data.clients.update(
              ctx.var.tenant_id,
              clientUpdate.client_id,
              {
                connections: [...currentConnections, id],
              },
            );
          }
        } else {
          // Disable: Remove connection if present
          if (currentConnections.includes(id)) {
            await ctx.env.data.clients.update(
              ctx.var.tenant_id,
              clientUpdate.client_id,
              {
                connections: currentConnections.filter((c) => c !== id),
              },
            );
          }
        }
      }

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Update Connection Clients",
        targetType: "connection_client",
        targetId: id,
      });

      return ctx.body(null, 204);
    },
  );
