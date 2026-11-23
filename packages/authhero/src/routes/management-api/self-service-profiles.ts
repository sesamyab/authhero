import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { Context } from "hono";
import {
  LogTypes,
  SELF_SERVICE_PROFILE_CUSTOM_TEXT_LANGUAGES,
  SELF_SERVICE_PROFILE_CUSTOM_TEXT_PAGES,
  SUPPORTED_SELF_SERVICE_STRATEGIES,
  SelfServiceProfile,
  SelfServiceProfileUpdate,
  SsoTicketConnectionConfig,
  escapeLuceneValue,
  normalizeConnectionDomain,
  selfServiceProfileSchema,
  selfServiceProfileStrategySchema,
  ssoTicketDomainVerificationSchema,
} from "@authhero/adapter-interfaces";
import {
  conflict,
  managementError,
  managementValidationHook,
  notFound,
} from "../../errors/management-api-error";
import { Bindings, Variables } from "../../types";
import { defineRoute } from "../../utils/define-route";
import { logMessage } from "../../helpers/logging";
import { getIssuer } from "../../variables";
import {
  SSO_TICKET_DEFAULT_TTL_SEC,
  SSO_TICKET_MAX_TTL_SEC,
  SSO_TICKET_PATH,
  generateSsoTicketId,
  hashSsoTicketId,
} from "../../helpers/sso-access-tickets";
import { requireTenantId } from "./helpers";

/**
 * Self-Service SSO (issue #1763): Auth0's nine `/api/v2/self-service-profiles`
 * endpoints with Auth0's paths, scopes and request/response shapes, and no
 * AuthHero-only endpoints.
 *
 * Request bodies are parsed strictly. A field Auth0 does not define, and an
 * Auth0 field AuthHero does not implement yet, is rejected with a 400 naming
 * the field, and nothing is stored. A client written for Auth0 therefore never
 * believes a setting took effect when it did not.
 */

/** Auth0 caps the number of self-service profiles per tenant. */
export const MAX_SELF_SERVICE_PROFILES = 20;

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

const SUPPORTED_STRATEGIES: readonly string[] =
  SUPPORTED_SELF_SERVICE_STRATEGIES;

function isSupportedStrategy(strategy: string): boolean {
  return SUPPORTED_STRATEGIES.includes(strategy);
}

/** A 400 in the shape the validation hook produces for body errors. */
function invalidBody(detail: string, property?: string) {
  const on = property ? ` on property ${property}` : "";
  return managementError(
    400,
    `Payload validation error: '${detail}'${on}.`,
    "invalid_body",
  );
}

/**
 * Hono hands the validator `{}` when the body is not JSON, which the
 * all-optional PATCH and the custom-text PUT would accept as "change nothing"
 * or "clear everything". Require a JSON body; an explicit JSON `{}` is fine.
 */
function requireJsonBody(ctx: Ctx) {
  const type = ctx.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw managementError(
      400,
      "Invalid request payload JSON format",
      "invalid_json",
    );
  }
}

function requireAdapters(ctx: Ctx) {
  const profiles = ctx.env.data.selfServiceProfiles;
  const tickets = ctx.env.data.ssoAccessTickets;
  if (!profiles || !tickets) {
    throw new HTTPException(501, {
      message: "Self-service SSO adapters not configured",
    });
  }
  return { profiles, tickets };
}

async function requireProfile(
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<SelfServiceProfile> {
  const profile = await requireAdapters(ctx).profiles.get(tenantId, id);
  if (!profile) throw notFound.selfServiceProfile();
  return profile;
}

// ---------------------------------------------------------------------------
// Strict body parsing
// ---------------------------------------------------------------------------

type RefinementCtx = {
  addIssue: (issue: {
    code: "custom";
    message: string;
    path: PropertyKey[];
  }) => void;
};

/**
 * An Auth0 field AuthHero does not implement yet. It is part of the schema so
 * that the strict object knows it, and refused when it carries a value.
 */
function unsupportedField(description: string) {
  return z
    .unknown()
    .optional()
    .openapi({
      description: `${description} Not supported by AuthHero yet: a request that sets it is rejected with 400.`,
    });
}

function rejectUnsupported(
  value: Record<string, unknown>,
  fields: readonly string[],
  ctx: RefinementCtx,
  path: PropertyKey[] = [],
) {
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== null) {
      ctx.addIssue({
        code: "custom",
        message: `${field} is not supported`,
        path: [...path, field],
      });
    }
  }
}

function rejectUnsupportedStrategies(
  strategies: readonly string[] | null | undefined,
  ctx: RefinementCtx,
) {
  strategies?.forEach((strategy, index) => {
    if (!isSupportedStrategy(strategy)) {
      ctx.addIssue({
        code: "custom",
        message: `Strategy ${strategy} is not supported; supported strategies are ${SUPPORTED_STRATEGIES.join(", ")}`,
        path: ["allowed_strategies", index],
      });
    }
  });
}

/** An absolute https URL with a host (Auth0: `format: uri`, `^https://`). */
function isHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const httpsUrlSchema = z
  .string()
  .max(1024)
  .refine(isHttpsUrl, { message: "Must be an https URL" });

const brandingBodySchema = z.strictObject({
  logo_url: httpsUrlSchema.optional(),
  colors: z
    .strictObject({
      primary: z.string().regex(/^#([\dA-Fa-f]{6}|[\dA-Fa-f]{3})$/),
    })
    .optional(),
});

const userAttributeBodySchema = z.strictObject({
  name: z.string().min(1).max(250),
  description: z.string(),
  is_optional: z.boolean(),
});

const PROFILE_UNSUPPORTED_FIELDS = ["user_attribute_profile_id"] as const;

const createProfileBodySchema = z
  .strictObject({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(140).optional(),
    branding: brandingBodySchema.optional(),
    allowed_strategies: z
      .array(selfServiceProfileStrategySchema)
      .min(1)
      .optional(),
    user_attributes: z.array(userAttributeBodySchema).optional(),
    user_attribute_profile_id: unsupportedField(
      "The user attribute profile used by the profile.",
    ),
  })
  .superRefine((value, ctx) => {
    rejectUnsupported(value, PROFILE_UNSUPPORTED_FIELDS, ctx);
    rejectUnsupportedStrategies(value.allowed_strategies, ctx);
  });

const updateProfileBodySchema = z
  .strictObject({
    name: z.string().min(1).max(100).optional(),
    description: z.string().min(1).max(140).nullable().optional(),
    branding: brandingBodySchema.nullable().optional(),
    allowed_strategies: z
      .array(selfServiceProfileStrategySchema)
      .min(1)
      .optional(),
    user_attributes: z.array(userAttributeBodySchema).nullable().optional(),
    user_attribute_profile_id: unsupportedField(
      "The user attribute profile used by the profile.",
    ),
  })
  .superRefine((value, ctx) => {
    rejectUnsupported(value, PROFILE_UNSUPPORTED_FIELDS, ctx);
    rejectUnsupportedStrategies(value.allowed_strategies, ctx);
  });

const customTextBodySchema = z.record(z.string(), z.string().max(2000));

const connectionOptionsBodySchema = z
  .strictObject({
    icon_url: httpsUrlSchema.nullable().optional(),
    domain_aliases: z
      .array(z.string().trim().min(1).max(255))
      .nullable()
      .optional(),
    idpinitiated: unsupportedField("IdP-initiated login options."),
  })
  .superRefine((value, ctx) => {
    rejectUnsupported(value, ["idpinitiated"], ctx);
  });

const connectionConfigBodySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9](-[a-zA-Z0-9]|[a-zA-Z0-9])*$/),
  display_name: z.string().max(128).optional(),
  is_domain_connection: z.boolean().optional(),
  show_as_button: z.boolean().optional(),
  metadata: z
    .record(z.string(), z.string().max(255).nullable())
    .refine((value) => Object.keys(value).length <= 10, {
      message: "metadata can have at most 10 properties",
    })
    .optional(),
  options: connectionOptionsBodySchema.nullable().optional(),
});

const enabledOrganizationBodySchema = z.strictObject({
  organization_id: z.string().min(1).max(50),
  assign_membership_on_login: z.boolean().optional(),
  show_as_button: z.boolean().optional(),
});

const domainAliasesConfigBodySchema = z
  .strictObject({
    domain_verification: ssoTicketDomainVerificationSchema,
    pending_domains: unsupportedField("Domains to verify."),
  })
  .superRefine((value, ctx) => {
    rejectUnsupported(value, ["pending_domains"], ctx);
  });

const TICKET_UNSUPPORTED_FIELDS = [
  "provisioning_config",
  "use_for_organization_discovery",
  "third_party_client_access_config",
  "universal_logout_config",
  "enabled_features",
] as const;

const ssoTicketBodySchema = z
  .strictObject({
    connection_id: z.string().min(1).optional().openapi({
      description: "Edit this existing connection through the ticket.",
    }),
    connection_config: connectionConfigBodySchema.optional().openapi({
      description: "Create a new connection through the ticket.",
    }),
    enabled_clients: z.array(z.string().min(1)).optional(),
    enabled_organizations: z.array(enabledOrganizationBodySchema).optional(),
    ttl_sec: z
      .number()
      .int()
      .min(0)
      .max(SSO_TICKET_MAX_TTL_SEC)
      .optional()
      .openapi({
        description: `Seconds the ticket stays valid. Unset or 0 means ${SSO_TICKET_DEFAULT_TTL_SEC} (5 days); at most ${SSO_TICKET_MAX_TTL_SEC} (30 days).`,
      }),
    domain_aliases_config: domainAliasesConfigBodySchema.optional().openapi({
      description:
        "Domain verification mode. Defaults to `required` when not specified.",
    }),
    provisioning_config: unsupportedField("SCIM provisioning."),
    use_for_organization_discovery: unsupportedField(
      "Use verified domains for organization discovery.",
    ),
    third_party_client_access_config: unsupportedField(
      "Third-party client access.",
    ),
    universal_logout_config: unsupportedField("Universal logout."),
    enabled_features: unsupportedField("Features enabled for the ticket."),
  })
  .superRefine((value, ctx) => {
    rejectUnsupported(value, TICKET_UNSUPPORTED_FIELDS, ctx);
  });

type SsoTicketBody = z.infer<typeof ssoTicketBodySchema>;

// ---------------------------------------------------------------------------
// Response and parameter schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(0).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  include_totals: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const listWithTotalsSchema = z.object({
  self_service_profiles: z.array(selfServiceProfileSchema),
  start: z.number(),
  limit: z.number(),
  total: z.number(),
});

const idParamSchema = z.object({ id: z.string() });
const customTextParamSchema = z.object({
  id: z.string(),
  language: z.enum(SELF_SERVICE_PROFILE_CUSTOM_TEXT_LANGUAGES),
  page: z.enum(SELF_SERVICE_PROFILE_CUSTOM_TEXT_PAGES),
});
const revokeParamSchema = z.object({ profileId: z.string(), id: z.string() });
const tenantHeaderSchema = z.object({ "tenant-id": z.string().optional() });
const ticketResponseSchema = z.object({ ticket: z.string() });

function auditLog(
  ctx: Ctx,
  tenantId: string,
  description: string,
  targetType: string,
  targetId: string,
  afterState?: Record<string, unknown>,
) {
  return logMessage(ctx, tenantId, {
    type: LogTypes.SUCCESS_API_OPERATION,
    description,
    targetType,
    targetId,
    ...(afterState ? { afterState } : {}),
  });
}

// ---------------------------------------------------------------------------
// Ticket validation
// ---------------------------------------------------------------------------

/** The connection config to store: `null` options and metadata values dropped. */
function toStoredConnectionConfig(
  config: z.infer<typeof connectionConfigBodySchema>,
): SsoTicketConnectionConfig {
  const stored: SsoTicketConnectionConfig = { name: config.name };
  if (config.display_name !== undefined)
    stored.display_name = config.display_name;
  if (config.is_domain_connection !== undefined)
    stored.is_domain_connection = config.is_domain_connection;
  if (config.show_as_button !== undefined)
    stored.show_as_button = config.show_as_button;
  if (config.metadata) {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.metadata)) {
      if (value !== null) metadata[key] = value;
    }
    stored.metadata = metadata;
  }
  if (config.options) {
    const options: NonNullable<SsoTicketConnectionConfig["options"]> = {};
    if (config.options.icon_url) options.icon_url = config.options.icon_url;
    if (config.options.domain_aliases) {
      // Domains compare case-insensitively; store them normalized, once each.
      options.domain_aliases = [
        ...new Set(
          config.options.domain_aliases.map(normalizeConnectionDomain),
        ),
      ];
    }
    stored.options = options;
  }
  return stored;
}

/**
 * Checks the ticket against the tenant: the connection to edit (or the name of
 * the one to create), the clients and the organizations must all be the
 * tenant's, and the strategy must be one the profile allows and AuthHero
 * supports.
 */
async function validateTicket(
  ctx: Ctx,
  tenantId: string,
  profile: SelfServiceProfile,
  body: SsoTicketBody,
): Promise<void> {
  const hasConnectionId = body.connection_id !== undefined;
  const hasConnectionConfig = body.connection_config !== undefined;
  if (hasConnectionId && hasConnectionConfig) {
    throw invalidBody(
      "Specify only one of connection_id and connection_config",
      "connection_id",
    );
  }
  if (!hasConnectionId && !hasConnectionConfig) {
    throw invalidBody("One of connection_id or connection_config is required");
  }

  const allowed = (
    profile.allowed_strategies ?? SUPPORTED_SELF_SERVICE_STRATEGIES
  ).filter(isSupportedStrategy);
  if (allowed.length === 0) {
    throw invalidBody(
      `The self-service profile allows no supported strategy; supported strategies are ${SUPPORTED_STRATEGIES.join(", ")}`,
    );
  }

  if (body.connection_id !== undefined) {
    const connection = await ctx.env.data.connections.get(
      tenantId,
      body.connection_id,
    );
    if (!connection) {
      throw invalidBody("The connection does not exist", "connection_id");
    }
    if (!allowed.some((strategy) => strategy === connection.strategy)) {
      throw invalidBody(
        `The connection's strategy ${connection.strategy} is not allowed by the self-service profile; allowed strategies are ${allowed.join(", ")}`,
        "connection_id",
      );
    }
  }

  if (body.connection_config !== undefined) {
    const name = body.connection_config.name;
    const { connections } = await ctx.env.data.connections.list(tenantId, {
      q: `name:${escapeLuceneValue(name)}`,
      per_page: 100,
    });
    if (connections.some((connection) => connection.name === name)) {
      throw conflict.connectionName();
    }
  }

  for (const [index, clientId] of (body.enabled_clients ?? []).entries()) {
    const client = await ctx.env.data.clients.get(tenantId, clientId);
    if (!client) {
      throw invalidBody(
        `The client ${clientId} does not exist`,
        `enabled_clients.${index}`,
      );
    }
  }

  for (const [index, organization] of (
    body.enabled_organizations ?? []
  ).entries()) {
    const found = await ctx.env.data.organizations.get(
      tenantId,
      organization.organization_id,
    );
    if (!found) {
      throw invalidBody(
        `The organization ${organization.organization_id} does not exist`,
        `enabled_organizations.${index}.organization_id`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listProfiles = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "get",
    path: "/",
    request: { query: listQuerySchema, headers: tenantHeaderSchema },
    security: [{ Bearer: ["read:self_service_profiles"] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.union([
              z.array(selfServiceProfileSchema),
              listWithTotalsSchema,
            ]),
          },
        },
        description: "Self-service profiles",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { page = 0, per_page = 50, include_totals } = ctx.req.valid("query");
    const all = await requireAdapters(ctx).profiles.list(tenantId);
    const start = page * per_page;
    const profiles = all.slice(start, start + per_page);
    if (include_totals) {
      return ctx.json({
        self_service_profiles: profiles,
        start,
        limit: per_page,
        total: all.length,
      });
    }
    return ctx.json(profiles);
  },
});

const createProfile = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "post",
    path: "/",
    request: {
      body: {
        content: { "application/json": { schema: createProfileBodySchema } },
        required: true,
      },
      headers: tenantHeaderSchema,
    },
    security: [{ Bearer: ["create:self_service_profiles"] }],
    responses: {
      201: {
        content: { "application/json": { schema: selfServiceProfileSchema } },
        description: "Created self-service profile",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { user_attribute_profile_id: _, ...body } = ctx.req.valid("json");
    const { profiles } = requireAdapters(ctx);

    const existing = await profiles.list(tenantId);
    if (existing.length >= MAX_SELF_SERVICE_PROFILES) {
      throw conflict.selfServiceProfileLimit();
    }

    const profile = await profiles.create(tenantId, body);
    await auditLog(
      ctx,
      tenantId,
      "Create self-service profile",
      "self_service_profile",
      profile.id,
      profile,
    );
    return ctx.json(profile, { status: 201 });
  },
});

const getProfile = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "get",
    path: "/{id}",
    request: { params: idParamSchema, headers: tenantHeaderSchema },
    security: [{ Bearer: ["read:self_service_profiles"] }],
    responses: {
      200: {
        content: { "application/json": { schema: selfServiceProfileSchema } },
        description: "A self-service profile",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    return ctx.json(await requireProfile(ctx, tenantId, id));
  },
});

const updateProfile = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "patch",
    path: "/{id}",
    request: {
      params: idParamSchema,
      body: {
        content: { "application/json": { schema: updateProfileBodySchema } },
        required: true,
      },
      headers: tenantHeaderSchema,
    },
    security: [{ Bearer: ["update:self_service_profiles"] }],
    responses: {
      200: {
        content: { "application/json": { schema: selfServiceProfileSchema } },
        description: "Updated self-service profile",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    requireJsonBody(ctx);
    const { user_attribute_profile_id: _, ...body } = ctx.req.valid("json");
    const { profiles } = requireAdapters(ctx);
    await requireProfile(ctx, tenantId, id);

    const update: SelfServiceProfileUpdate = body;
    await profiles.update(tenantId, id, update);
    const updated = await requireProfile(ctx, tenantId, id);
    await auditLog(
      ctx,
      tenantId,
      "Update self-service profile",
      "self_service_profile",
      id,
      updated,
    );
    return ctx.json(updated);
  },
});

const deleteProfile = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "delete",
    path: "/{id}",
    request: { params: idParamSchema, headers: tenantHeaderSchema },
    security: [{ Bearer: ["delete:self_service_profiles"] }],
    responses: {
      204: { description: "Self-service profile successfully deleted." },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    await requireProfile(ctx, tenantId, id);
    // Also removes the profile's custom text and SSO access tickets. A
    // concurrent DELETE may have removed it since the check.
    if (!(await requireAdapters(ctx).profiles.remove(tenantId, id))) {
      throw notFound.selfServiceProfile();
    }
    await auditLog(
      ctx,
      tenantId,
      "Delete self-service profile",
      "self_service_profile",
      id,
    );
    return ctx.body(null, 204);
  },
});

const getCustomText = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "get",
    path: "/{id}/custom-text/{language}/{page}",
    request: { params: customTextParamSchema, headers: tenantHeaderSchema },
    security: [{ Bearer: ["read:self_service_profile_custom_texts"] }],
    responses: {
      200: {
        content: { "application/json": { schema: customTextBodySchema } },
        description: "Custom text for the language and page",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id, language, page } = ctx.req.valid("param");
    await requireProfile(ctx, tenantId, id);
    return ctx.json(
      await requireAdapters(ctx).profiles.getCustomText(
        tenantId,
        id,
        language,
        page,
      ),
    );
  },
});

const setCustomText = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "put",
    path: "/{id}/custom-text/{language}/{page}",
    request: {
      params: customTextParamSchema,
      body: {
        content: { "application/json": { schema: customTextBodySchema } },
        required: true,
      },
      headers: tenantHeaderSchema,
    },
    security: [{ Bearer: ["update:self_service_profile_custom_texts"] }],
    responses: {
      200: {
        content: { "application/json": { schema: customTextBodySchema } },
        description: "The custom text now set",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id, language, page } = ctx.req.valid("param");
    requireJsonBody(ctx);
    const body = ctx.req.valid("json");
    await requireProfile(ctx, tenantId, id);
    const { profiles } = requireAdapters(ctx);
    // The profile can be deleted between the check above and the write.
    if (!(await profiles.setCustomText(tenantId, id, language, page, body))) {
      throw notFound.selfServiceProfile();
    }
    await auditLog(
      ctx,
      tenantId,
      "Set self-service profile custom text",
      "self_service_profile",
      id,
    );
    // What this request wrote (stored as given), not a later read that could
    // see a concurrent write.
    return ctx.json(body);
  },
});

const createSsoTicket = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "post",
    path: "/{id}/sso-ticket",
    request: {
      params: idParamSchema,
      body: {
        content: { "application/json": { schema: ssoTicketBodySchema } },
      },
      headers: tenantHeaderSchema,
    },
    security: [{ Bearer: ["create:sso_access_tickets"] }],
    responses: {
      201: {
        content: { "application/json": { schema: ticketResponseSchema } },
        description:
          "The ticket URL. It is the only copy of the ticket id, which is stored hashed.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json");
    const profile = await requireProfile(ctx, tenantId, id);
    await validateTicket(ctx, tenantId, profile, body);

    const ttlSec = body.ttl_sec || SSO_TICKET_DEFAULT_TTL_SEC;
    const ticketId = generateSsoTicketId();
    const ticket = await requireAdapters(ctx).tickets.create(tenantId, {
      profile_id: profile.id,
      ticket_hash: await hashSsoTicketId(ticketId),
      ...(body.connection_id !== undefined
        ? { connection_id: body.connection_id }
        : {}),
      ...(body.connection_config !== undefined
        ? {
            connection_config: toStoredConnectionConfig(body.connection_config),
          }
        : {}),
      enabled_clients: body.enabled_clients ?? [],
      enabled_organizations: body.enabled_organizations ?? [],
      // Safer default than Auth0's `none`: a domain must be verified before
      // the connection can be enabled.
      domain_verification:
        body.domain_aliases_config?.domain_verification ?? "required",
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    });

    // The internal row id is the log target, never the ticket id.
    await auditLog(
      ctx,
      tenantId,
      "Create SSO access ticket",
      "sso_access_ticket",
      ticket.id,
      {
        profile_id: ticket.profile_id,
        ...(ticket.connection_id
          ? { connection_id: ticket.connection_id }
          : {}),
        expires_at: ticket.expires_at,
      },
    );

    const url = new URL(
      SSO_TICKET_PATH,
      getIssuer(ctx.env, ctx.var.custom_domain),
    );
    url.searchParams.set("ticket", ticketId);
    // On the shared issuer host nothing else identifies the tenant, and
    // tickets are looked up per tenant (as in tickets.ts).
    if (!ctx.var.custom_domain) {
      url.searchParams.set("tenant_id", tenantId);
    }
    return ctx.json({ ticket: url.toString() }, { status: 201 });
  },
});

const revokeSsoTicket = defineRoute({
  route: createRoute({
    tags: ["self-service-profiles"],
    method: "post",
    path: "/{profileId}/sso-ticket/{id}/revoke",
    request: { params: revokeParamSchema, headers: tenantHeaderSchema },
    security: [{ Bearer: ["delete:sso_access_tickets"] }],
    responses: {
      202: {
        description:
          "Revocation accepted. As in Auth0, also returned when the ticket does not exist.",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { profileId, id } = ctx.req.valid("param");
    const { tickets } = requireAdapters(ctx);

    // The `{id}` is the ticket id from the ticket URL; only its hash is
    // stored. A ticket of another tenant or profile is never matched.
    const ticket = await tickets.getByTicketHash(
      tenantId,
      await hashSsoTicketId(id),
    );
    if (ticket && ticket.profile_id === profileId && !ticket.revoked_at) {
      await tickets.update(tenantId, ticket.id, {
        revoked_at: new Date().toISOString(),
      });
      await auditLog(
        ctx,
        tenantId,
        "Revoke SSO access ticket",
        "sso_access_ticket",
        ticket.id,
      );
    }
    return ctx.body(null, 202);
  },
});

export const selfServiceProfilesRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  listProfiles,
  createProfile,
  getProfile,
  updateProfile,
  deleteProfile,
  getCustomText,
  setCustomText,
  createSsoTicket,
  revokeSsoTicket,
] as const);
