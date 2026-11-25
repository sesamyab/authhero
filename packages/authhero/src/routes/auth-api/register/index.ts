import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { LogTypes, escapeLuceneValue } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../../types";
import { JSONHTTPException } from "../../../errors/json-http-exception";
import { logMessage } from "../../../helpers/logging";
import {
  dcrRequestSchema,
  dcrResponseSchema,
  clientToDcrResponse,
} from "../../../helpers/dcr/metadata-mapping";
import {
  registerClient,
  updateRegisteredClient,
  updatesRestrictedToEditableFields,
} from "../../../helpers/dcr/client-registration";
import { clientPreset } from "../../../helpers/dcr/presets";
import {
  authenticateManagementRequest,
  authenticateRegistrationRequest,
  assertDcrEnabled,
  isClientSoftDeleted,
  loadTenantOrFail,
  registrationClientUri,
  requireClientRegistrationTokens,
} from "./shared";

export const registerRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>()
  // --------------------------------
  // POST /oidc/register  (RFC 7591)
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["oidc-register"],
      method: "post",
      path: "/",
      request: {
        body: {
          content: {
            "application/json": {
              schema: dcrRequestSchema,
            },
          },
        },
      },
      responses: {
        201: {
          content: {
            "application/json": { schema: dcrResponseSchema },
          },
          description: "Client registered",
        },
      },
    }),
    async (ctx) => {
      const tenant = await loadTenantOrFail(ctx);
      assertDcrEnabled(tenant);

      const iat = await authenticateRegistrationRequest(ctx, tenant);
      const body = ctx.req.valid("json");

      const registered = await registerClient(ctx, tenant, iat, body, {
        issueRegistrationAccessToken: true,
      });
      const client_id = registered.client.client_id;

      const response = clientToDcrResponse(registered.client, {
        client_secret: registered.client_secret,
        registration_access_token: registered.registration_access_token,
        registration_client_uri: registrationClientUri(ctx, client_id),
        include_client_secret: registered.client_secret !== undefined,
      });

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "Dynamic Client Registration",
        targetType: "client",
        targetId: client_id,
      });

      return ctx.json(response, { status: 201 });
    },
  )
  // --------------------------------
  // GET /oidc/register/:client_id  (RFC 7592)
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["oidc-register"],
      method: "get",
      path: "/{client_id}",
      request: {
        params: z.object({ client_id: z.string() }),
      },
      responses: {
        200: {
          content: { "application/json": { schema: dcrResponseSchema } },
          description: "Client configuration",
        },
      },
    }),
    async (ctx) => {
      const tenant = await loadTenantOrFail(ctx);
      assertDcrEnabled(tenant);

      const { client_id } = ctx.req.valid("param");
      await authenticateManagementRequest(ctx, client_id);

      const client = await ctx.env.data.clients.get(
        ctx.var.tenant_id,
        client_id,
      );
      if (!client || isClientSoftDeleted(client)) {
        throw new JSONHTTPException(401, {
          error: "invalid_token",
          error_description: "Client not found",
        });
      }

      const response = clientToDcrResponse(client, {
        registration_client_uri: registrationClientUri(ctx, client_id),
        include_client_secret: false,
      });
      return ctx.json(response);
    },
  )
  // --------------------------------
  // PUT /oidc/register/:client_id  (RFC 7592)
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["oidc-register"],
      method: "put",
      path: "/{client_id}",
      request: {
        params: z.object({ client_id: z.string() }),
        body: {
          content: {
            "application/json": { schema: dcrRequestSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: dcrResponseSchema } },
          description: "Updated client configuration",
        },
      },
    }),
    async (ctx) => {
      const tenant = await loadTenantOrFail(ctx);
      assertDcrEnabled(tenant);

      const { client_id } = ctx.req.valid("param");
      const token = await authenticateManagementRequest(ctx, client_id);

      const existing = await ctx.env.data.clients.get(
        ctx.var.tenant_id,
        client_id,
      );
      if (!existing || isClientSoftDeleted(existing)) {
        throw new JSONHTTPException(401, {
          error: "invalid_token",
          error_description: "Client not found",
        });
      }

      const body = ctx.req.valid("json");

      if (body.client_id !== undefined && body.client_id !== client_id) {
        throw new JSONHTTPException(400, {
          error: "invalid_client_metadata",
          error_description: "client_id in body does not match URL",
        });
      }

      const { client: updated, changed } = await updateRegisteredClient(
        ctx,
        tenant,
        existing,
        body,
        {
          editableFieldsOnly: updatesRestrictedToEditableFields(
            existing,
            token,
          ),
        },
      );

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description:
          changed.length > 0
            ? `RFC 7592 Client Update: ${changed.join(", ")}`
            : "RFC 7592 Client Update",
        targetType: "client",
        targetId: client_id,
      });

      const response = clientToDcrResponse(updated, {
        registration_client_uri: registrationClientUri(ctx, client_id),
        include_client_secret: false,
      });
      return ctx.json(response);
    },
  )
  // --------------------------------
  // DELETE /oidc/register/:client_id  (RFC 7592)
  // --------------------------------
  .openapi(
    createRoute({
      tags: ["oidc-register"],
      method: "delete",
      path: "/{client_id}",
      request: {
        params: z.object({ client_id: z.string() }),
      },
      responses: {
        204: { description: "Client deleted" },
      },
    }),
    async (ctx) => {
      const tenant = await loadTenantOrFail(ctx);
      assertDcrEnabled(tenant);

      const { client_id } = ctx.req.valid("param");
      const token = await authenticateManagementRequest(ctx, client_id);

      const existing = await ctx.env.data.clients.get(
        ctx.var.tenant_id,
        client_id,
      );
      if (!existing || isClientSoftDeleted(existing)) {
        throw new JSONHTTPException(401, {
          error: "invalid_token",
          error_description: "Client not found",
        });
      }

      // The operator owns the lifecycle of apps registered by invite and of
      // apps opened up through an edit link: the developer may update them,
      // not delete them (RFC 7592 §2.3 allows refusing with 405).
      if (
        token.source === "edit_link" ||
        clientPreset(existing.registration_metadata) !== undefined
      ) {
        throw new JSONHTTPException(405, {
          error: "invalid_request",
          error_description: "This client cannot be deleted with this token",
        });
      }

      const metadata: Record<string, string> = {
        ...(existing.client_metadata ?? {}),
        status: "deleted",
      };

      const grantsToRemove = await ctx.env.data.clientGrants.list(
        ctx.var.tenant_id,
        { q: `client_id:${escapeLuceneValue(client_id)}` },
      );

      await ctx.env.data.transaction(async (trx) => {
        await trx.clients.update(ctx.var.tenant_id, client_id, {
          client_metadata: metadata,
        });
        for (const grant of grantsToRemove.client_grants) {
          if (grant.id) {
            await trx.clientGrants.remove(ctx.var.tenant_id, grant.id);
          }
        }
        await requireClientRegistrationTokens(trx).revokeByClient(
          ctx.var.tenant_id,
          client_id,
          new Date().toISOString(),
        );
      });

      await logMessage(ctx, ctx.var.tenant_id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: "RFC 7592 Client Delete",
        targetType: "client",
        targetId: client_id,
      });

      return ctx.body(null, 204);
    },
  );
