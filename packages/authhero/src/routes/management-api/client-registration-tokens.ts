import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  managementError,
  managementValidationHook,
  notFound,
} from "../../errors/management-api-error";
import {
  LogTypes,
  clientRegistrationTokenSourceSchema,
  clientRegistrationTokenTypeSchema,
  type ClientRegistrationToken,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { logMessage } from "../../helpers/logging";
import { mintIat } from "../../helpers/dcr/mint-iat";
import { mintRegistrationToken } from "../../helpers/dcr/mint-token";
import { isRegistrationDeniedAudience } from "../../helpers/dcr/audience-policy";
import { deepEqual } from "../../helpers/dcr/constraint-enforcement";
import { APP_PRESETS, presetConstraints } from "../../helpers/dcr/presets";
import {
  APP_TICKET_DEFAULT_TTL_SEC,
  APP_TICKET_MAX_TTL_SEC,
  APP_TICKET_PATH,
  buildTicketUrl,
} from "../../helpers/self-service-tickets";
import { requireClientRegistrationTokens } from "../auth-api/register/shared";
import { isTryConnectionClientId } from "../../constants";

import { defineRoute } from "../../utils/define-route";
import { listResponse, requireTenantId } from "./helpers";

/** Payload validation error in the shape the validation hook produces. */
function invalidBody(detail: string, property: string) {
  return managementError(
    400,
    `Payload validation error: '${detail}' on property ${property}.`,
    "invalid_body",
  );
}

const tokenStatusSchema = z.enum(["active", "used", "expired", "revoked"]);
type TokenStatus = z.infer<typeof tokenStatusSchema>;

/**
 * A used single-use invite stays "used" (linking to its app) even after the
 * app is deleted and its tokens revoked.
 */
function tokenStatus(token: ClientRegistrationToken): TokenStatus {
  if (token.single_use && token.used_at) return "used";
  if (token.revoked_at) return "revoked";
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return "expired";
  }
  return "active";
}

const tokenViewSchema = z.object({
  id: z.string(),
  type: clientRegistrationTokenTypeSchema,
  source: clientRegistrationTokenSourceSchema.optional(),
  name: z.string().optional(),
  status: tokenStatusSchema,
  client_id: z.string().optional().openapi({
    description:
      "For a registration access token or edit link, the client it manages. For a used invite, the client it created.",
  }),
  sub: z.string().optional(),
  created_by: z.string().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  single_use: z.boolean(),
  expires_at: z.string().optional(),
  used_at: z.string().optional(),
  revoked_at: z.string().optional(),
  created_at: z.string(),
});
type TokenView = z.infer<typeof tokenViewSchema>;

/** Never exposes the token hash. */
function toView(token: ClientRegistrationToken): TokenView {
  return {
    id: token.id,
    type: token.type,
    source: token.source,
    name: token.name,
    status: tokenStatus(token),
    client_id: token.client_id,
    sub: token.sub,
    created_by: token.created_by,
    constraints: token.constraints,
    single_use: token.single_use,
    expires_at: token.expires_at,
    used_at: token.used_at,
    revoked_at: token.revoked_at,
    created_at: token.created_at,
  };
}

const mintBodySchema = z.object({
  sub: z.string().optional().openapi({
    description: "User ID to bind the IAT to (optional)",
  }),
  constraints: z.record(z.string(), z.unknown()).optional().openapi({
    description:
      "Pre-bound metadata that the registration request must match exactly (or omit, in which case the value is filled in from this map). With `preset`, these may add to the preset but not contradict it.",
  }),
  expires_in_seconds: z
    .number()
    .int()
    .min(30)
    .max(APP_TICKET_MAX_TTL_SEC)
    .optional()
    .openapi({
      description: `Token TTL in seconds, at most ${APP_TICKET_MAX_TTL_SEC} (30 days). Default 300 (5 minutes), or ${APP_TICKET_DEFAULT_TTL_SEC} (7 days) with \`preset\`.`,
    }),
  single_use: z.boolean().optional().openapi({
    description:
      "Whether the IAT is invalidated after first use. Default true.",
  }),
  preset: z.enum(APP_PRESETS).optional().openapi({
    description:
      "Developer invite: pins the app type and its OAuth settings (code flow with PKCE and refresh tokens; no secret for native and single-page apps) and returns a setup page URL in `ticket`.",
  }),
  name: z.string().min(1).max(255).optional().openapi({
    description:
      "Label shown to operators, e.g. who the invite is for. Required with `preset`.",
  }),
  connections: z.array(z.string()).max(100).optional().openapi({
    description:
      "With `preset`: connection ids the app may use. Unset means all of the tenant's connections, including ones added later.",
  }),
  is_first_party: z.boolean().optional().openapi({
    description:
      "With `preset`: whether the app skips the consent screen. Default true.",
  }),
});

const mintResponseSchema = z.object({
  id: z.string(),
  token: z.string(),
  expires_at: z.string(),
  sub: z.string().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  single_use: z.boolean(),
  name: z.string().optional(),
  source: clientRegistrationTokenSourceSchema.optional(),
  ticket: z.string().optional().openapi({
    description:
      "With `preset`: the setup page URL to send to the developer. It contains the token; shown once.",
  }),
});

const postRoot = defineRoute({
  route: createRoute({
    tags: ["client-registration-tokens"],
    method: "post",
    path: "/",
    request: {
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
      body: {
        content: {
          "application/json": { schema: mintBodySchema },
        },
      },
    },
    security: [
      {
        Bearer: ["create:client_registration_tokens"],
      },
    ],
    responses: {
      201: {
        content: { "application/json": { schema: mintResponseSchema } },
        description:
          "Initial Access Token issued. The `token` field is shown once and not retrievable later.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const body = ctx.req.valid("json");

    let constraints = body.constraints;
    if (body.preset) {
      if (!body.name) {
        throw invalidBody("Missing required property: name", "name");
      }
      const preset = presetConstraints(body.preset);
      for (const [key, value] of Object.entries(body.constraints ?? {})) {
        const pinned = Object.entries(preset).find(([k]) => k === key);
        if (pinned && !deepEqual(pinned[1], value)) {
          throw invalidBody(
            `Constraint ${key} conflicts with the ${body.preset} preset`,
            `constraints.${key}`,
          );
        }
      }
      if (body.connections) {
        const { connections } = await ctx.env.data.connections.list(tenant_id);
        const known = new Set(connections.map((c) => c.id));
        const unknown = body.connections.find((id) => !known.has(id));
        if (unknown) {
          throw invalidBody(`Unknown connection: ${unknown}`, "connections");
        }
      }
      constraints = {
        ...(body.constraints ?? {}),
        ...preset,
        ...(body.connections && body.connections.length > 0
          ? { connections: body.connections }
          : {}),
        ...(body.is_first_party !== undefined
          ? { is_first_party: body.is_first_party }
          : {}),
      };
    } else if (body.connections || body.is_first_party !== undefined) {
      const property = body.connections ? "connections" : "is_first_party";
      throw invalidBody(`${property} requires preset`, property);
    }

    // Registration refuses to grant these audiences, so an IAT pinning one
    // could never be used. Fail here instead of at /oidc/register.
    const pinnedAudience = constraints?.audience;
    if (
      typeof pinnedAudience === "string" &&
      (await isRegistrationDeniedAudience(ctx, tenant_id, pinnedAudience))
    ) {
      throw invalidBody(
        `Audience cannot be granted through Dynamic Client Registration: ${pinnedAudience}`,
        "constraints.audience",
      );
    }

    const minted = await mintIat(
      requireClientRegistrationTokens(ctx.env.data),
      tenant_id,
      {
        sub: body.sub,
        constraints,
        expires_in_seconds:
          body.expires_in_seconds ??
          (body.preset ? APP_TICKET_DEFAULT_TTL_SEC : undefined),
        single_use: body.single_use,
        name: body.name,
        created_by: ctx.var.user_id,
        source: body.preset ? "invite" : undefined,
      },
    );

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: body.preset
        ? `Developer invite created (${body.preset})`
        : "DCR Initial Access Token issued via Management API",
      targetType: "client_registration_token",
      targetId: minted.id,
      userId: body.sub,
    });

    return ctx.json(
      {
        id: minted.id,
        token: minted.token,
        expires_at: minted.expires_at,
        sub: minted.record.sub,
        constraints: minted.record.constraints,
        single_use: minted.record.single_use,
        name: minted.record.name,
        source: minted.record.source,
        ...(body.preset
          ? {
              ticket: buildTicketUrl(
                ctx,
                APP_TICKET_PATH,
                minted.token,
                tenant_id,
              ),
            }
          : {}),
      },
      201,
    );
  },
});

const listQuerySchema = z.object({
  type: clientRegistrationTokenTypeSchema.optional(),
  source: clientRegistrationTokenSourceSchema.optional(),
  client_id: z.string().optional(),
  page: z
    .string()
    .optional()
    .default("0")
    .transform((p) => parseInt(p, 10))
    .pipe(z.number().int().min(0)),
  per_page: z
    .string()
    .optional()
    .default("50")
    .transform((p) => parseInt(p, 10))
    .pipe(z.number().int().min(1).max(100)),
  include_totals: z
    .string()
    .optional()
    .default("false")
    .transform((it) => it === "true"),
});

const getRoot = defineRoute({
  route: createRoute({
    tags: ["client-registration-tokens"],
    method: "get",
    path: "/",
    request: {
      query: listQuerySchema,
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["read:client_registration_tokens"],
      },
    ],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.union([
              z.array(tokenViewSchema),
              z.object({
                client_registration_tokens: z.array(tokenViewSchema),
                start: z.number(),
                limit: z.number(),
                length: z.number(),
                total: z.number(),
              }),
            ]),
          },
        },
        description:
          "Registration tokens, newest first. Tokens and their hashes are never returned.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const query = ctx.req.valid("query");
    const result = await requireClientRegistrationTokens(ctx.env.data).list(
      tenant_id,
      query,
    );
    return ctx.json(
      listResponse(
        query.include_totals,
        {
          ...result,
          client_registration_tokens:
            result.client_registration_tokens.map(toView),
        },
        "client_registration_tokens",
      ),
    );
  },
});

async function requireToken(
  ctx: { env: Bindings },
  tenant_id: string,
  id: string,
): Promise<ClientRegistrationToken> {
  const token = await requireClientRegistrationTokens(ctx.env.data).get(
    tenant_id,
    id,
  );
  if (!token) {
    throw managementError(
      404,
      "The client registration token does not exist.",
      "inexistent_client_registration_token",
    );
  }
  return token;
}

const getById = defineRoute({
  route: createRoute({
    tags: ["client-registration-tokens"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["read:client_registration_tokens"],
      },
    ],
    responses: {
      200: {
        content: { "application/json": { schema: tokenViewSchema } },
        description: "A registration token",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    return ctx.json(toView(await requireToken(ctx, tenant_id, id)));
  },
});

const postRevoke = defineRoute({
  route: createRoute({
    tags: ["client-registration-tokens"],
    method: "post",
    path: "/{id}/revoke",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
    },
    security: [
      {
        Bearer: ["delete:client_registration_tokens"],
      },
    ],
    responses: {
      202: {
        description:
          "Revoked. The row is kept (status `revoked`); revoking twice is a no-op.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    await requireToken(ctx, tenant_id, id);

    await requireClientRegistrationTokens(ctx.env.data).revoke(
      tenant_id,
      id,
      new Date().toISOString(),
    );

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Revoke a Client Registration Token",
      targetType: "client_registration_token",
      targetId: id,
    });

    return ctx.body(null, 202);
  },
});

export const clientRegistrationTokenRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  postRoot,
  getRoot,
  getById,
  postRevoke,
] as const);

// --------------------------------
// POST /clients/{id}/registration-ticket — developer edit link
// --------------------------------

const registrationTicketBodySchema = z.object({
  ttl_sec: z
    .number()
    .int()
    .min(60)
    .max(APP_TICKET_MAX_TTL_SEC)
    .optional()
    .openapi({
      description: `Seconds the edit link stays valid. Default ${APP_TICKET_DEFAULT_TTL_SEC} (7 days), at most ${APP_TICKET_MAX_TTL_SEC} (30 days).`,
    }),
});

const postRegistrationTicket = defineRoute({
  route: createRoute({
    tags: ["clients"],
    method: "post",
    path: "/{id}/registration-ticket",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({
        "tenant-id": z.string().optional(),
      }),
      body: {
        content: {
          "application/json": { schema: registrationTicketBodySchema },
        },
      },
    },
    security: [
      {
        Bearer: ["create:client_registration_tokens"],
      },
    ],
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              ticket: z.string(),
              expires_at: z.string(),
            }),
          },
        },
        description:
          "Edit link for an outside developer: opens the setup page pre-filled with the app's settings and allows changing only its URLs, name, logo and contact details. Previous edit links of the client are revoked. The URL is shown once.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenant_id = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json");

    const client = await ctx.env.data.clients.get(tenant_id, id);
    if (
      !client ||
      client.client_metadata?.status === "deleted" ||
      client.client_metadata?.system_purpose === "try_connection" ||
      isTryConnectionClientId(client.client_id)
    ) {
      throw notFound.client();
    }
    if (client.global || client.client_metadata?.cimd === "true") {
      throw managementError(
        400,
        "Edit links are not available for this client.",
        "invalid_client",
      );
    }

    const tokens = requireClientRegistrationTokens(ctx.env.data);
    const now = new Date().toISOString();

    // One active edit link per client: a new link replaces the old ones.
    const previous = await tokens.list(tenant_id, {
      client_id: id,
      source: "edit_link",
      per_page: 100,
    });
    for (const token of previous.client_registration_tokens) {
      if (!token.revoked_at) {
        await tokens.revoke(tenant_id, token.id, now);
      }
    }

    const ttl = body.ttl_sec ?? APP_TICKET_DEFAULT_TTL_SEC;
    const expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    const minted = await mintRegistrationToken();
    await tokens.create(tenant_id, {
      id: minted.id,
      token_hash: minted.token_hash,
      type: "rat",
      client_id: id,
      single_use: false,
      expires_at,
      source: "edit_link",
      created_by: ctx.var.user_id,
    });

    await logMessage(ctx, tenant_id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Create a Client Registration Ticket",
      targetType: "client",
      targetId: id,
    });

    return ctx.json(
      {
        id: minted.id,
        ticket: buildTicketUrl(ctx, APP_TICKET_PATH, minted.token, tenant_id),
        expires_at,
      },
      201,
    );
  },
});

export const clientRegistrationTicketRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  postRegistrationTicket,
] as const);
