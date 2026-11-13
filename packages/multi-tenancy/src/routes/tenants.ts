import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  tenantInsertSchema,
  tenantPatchSchema,
  tenantSchema,
  auth0QuerySchema,
  CreateTenantParams,
  fetchAll,
  deepMergePatch,
  isInteractiveClient,
  DataAdapters,
  Tenant,
} from "authhero";
import {
  MultiTenancyBindings,
  MultiTenancyVariables,
  MultiTenancyConfig,
  MultiTenancyHooks,
  TenantHookContext,
} from "../types";
import { getRequestData } from "../middleware/request-data";
import { computedTenantFields } from "../utils/tenant-settings";
import { validateTenantParent } from "../utils/tenant-tree";
import { findCaseCollidingTenantId } from "../utils/tenant-id-collision";
import { resolveDeploymentTypes } from "../utils/deployment-types";

// How an organization-scoped tenant search reads the matches: in batches of
// this size, up to this many batches before it refuses the search.
const SEARCH_BATCH_SIZE = 100;
const SEARCH_MAX_BATCHES = 100;

const deploymentTypeSchema = z.enum(["shared", "wfp"]);

// The shared insert schema defaults `deployment_type` to "shared", which would
// hide whether the caller chose it. Without the default, an omitted type takes
// the cluster's configured default instead.
const createTenantBodySchema = tenantInsertSchema.extend({
  deployment_type: deploymentTypeSchema.optional(),
});

const deploymentOptionsSchema = z.object({
  deployment_types: z.array(deploymentTypeSchema),
  default_deployment_type: deploymentTypeSchema,
  /** The hostname a new tenant gets, with `{id}` for the tenant id. */
  tenant_host_template: z.string().optional(),
});

/**
 * The subset of token claims we read off `ctx.var.user` to make tenant
 * authorization decisions. Parsed defensively with zod so we never reach for
 * `as` casts on the loosely-typed context variable.
 */
const callerClaimsSchema = z
  .object({
    sub: z.string(),
    tenant_id: z.string().optional(),
    org_id: z.string().optional(),
    scope: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  })
  .passthrough();

type CallerClaims = z.infer<typeof callerClaimsSchema>;

function parseCaller(user: unknown): CallerClaims | undefined {
  const result = callerClaimsSchema.safeParse(user);
  return result.success ? result.data : undefined;
}

/**
 * Whether the caller carries a scope/permission that grants tenant
 * administration across the control plane (i.e. without per-tenant
 * organization membership).
 *
 * `delete:tenants` is the scope the DELETE route declares in its OpenAPI
 * security; `admin:organizations` is the broader claim the list route already
 * treats as full access, kept here so create/list/delete stay symmetric.
 */
/**
 * Whether the caller's token comes from the control plane (not an
 * organization-scoped tenant credential). Deployments without a control plane
 * are single-tenant, which is effectively one.
 */
function callerIsControlPlane(
  caller: CallerClaims | undefined,
  controlPlaneTenantId: string | undefined,
  orgScoped: boolean,
): boolean {
  if (!controlPlaneTenantId) return true;
  if (!caller || orgScoped) return false;
  // A token without a tenant is not proof of anything: require the claim.
  return caller.tenant_id === controlPlaneTenantId;
}

function callerHasGlobalTenantAdmin(caller: CallerClaims): boolean {
  const permissions = caller.permissions ?? [];
  const scopes = caller.scope ? caller.scope.split(" ").filter(Boolean) : [];
  const granted = new Set([...permissions, ...scopes]);
  return granted.has("delete:tenants") || granted.has("admin:organizations");
}

/**
 * Creates OpenAPI-based tenant management routes.
 *
 * These routes handle CRUD operations for tenants and are designed to be
 * mounted on authhero's management API so they get the same authentication
 * middleware.
 *
 * @param config - Multi-tenancy configuration
 * @param hooks - Multi-tenancy hooks for lifecycle events
 * @returns OpenAPIHono router with tenant routes
 */
export function createTenantsOpenAPIRouter(
  config: MultiTenancyConfig,
  hooks: MultiTenancyHooks,
) {
  const app = new OpenAPIHono<{
    Bindings: MultiTenancyBindings;
    Variables: MultiTenancyVariables;
  }>();

  const deploymentTypes = resolveDeploymentTypes(config.deploymentTypes);

  const isControlPlaneCaller = (ctx: {
    var: {
      user?: unknown;
      data?: DataAdapters;
      organization_id?: string;
      org_name?: string;
    };
    env: { data: DataAdapters };
  }): boolean => {
    const caller = parseCaller(ctx.var.user);
    return callerIsControlPlane(
      caller,
      config.accessControl?.controlPlaneTenantId ??
        getRequestData(ctx).multiTenancyConfig?.controlPlaneTenantId,
      Boolean(caller?.org_id ?? ctx.var.organization_id ?? ctx.var.org_name),
    );
  };

  const computedFields = (
    ctx: { env: { data: DataAdapters }; var: { data?: DataAdapters } },
    tenantId: string,
  ) =>
    computedTenantFields(
      getRequestData(ctx).tenants,
      tenantId,
      config.accessControl?.controlPlaneTenantId ??
        getRequestData(ctx).multiTenancyConfig?.controlPlaneTenantId,
    );

  // --------------------------------
  // GET / - List tenants the user has access to
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants"],
      method: "get",
      path: "/",
      request: {
        query: auth0QuerySchema,
      },
      security: [
        {
          Bearer: [],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                tenants: z.array(tenantSchema),
                start: z.number().optional(),
                limit: z.number().optional(),
                length: z.number().optional(),
                total: z.number().optional(),
              }),
            },
          },
          description: "List of tenants",
        },
      },
    }),
    async (ctx) => {
      const query = ctx.req.valid("query");
      const { page, per_page, include_totals, q } = query;

      // Get the current user from context (set by authhero's auth middleware)
      const user = ctx.var.user as
        | {
            sub: string;
            tenant_id: string;
            scope?: string;
            permissions?: string[];
            org_id?: string;
          }
        | undefined;

      // If user has admin:organizations permission, allow access to all tenants.
      // Why: tokens with an org_id were issued for a specific organization, so any
      // admin:organizations permission they carry came from an org-scoped role — not a
      // global one — and must not bypass per-org tenant filtering.
      const userPermissions = user?.permissions || [];
      const tokenIsOrgScoped = Boolean(user?.org_id ?? ctx.var.organization_id);
      const hasFullAccess =
        !tokenIsOrgScoped && userPermissions.includes("admin:organizations");

      if (hasFullAccess) {
        const result = await getRequestData(ctx).tenants.list({
          page,
          per_page,
          include_totals,
          q,
        });

        if (include_totals) {
          return ctx.json({
            tenants: result.tenants,
            start: result.totals?.start ?? 0,
            limit: result.totals?.limit ?? per_page,
            length: result.tenants.length,
            total: result.totals?.length,
          });
        }

        return ctx.json({ tenants: result.tenants });
      }

      // Get control plane tenant ID from config or from adapters' multiTenancyConfig
      const controlPlaneTenantId =
        config.accessControl?.controlPlaneTenantId ??
        getRequestData(ctx).multiTenancyConfig?.controlPlaneTenantId;

      // When access control is enabled, a token without a subject must not
      // fall through to the global "return all tenants" path below — that
      // would bypass the per-organization filtering entirely. Reject instead.
      if (controlPlaneTenantId && !user?.sub) {
        throw new HTTPException(403, {
          message: "Access denied: token has no subject",
        });
      }

      // If access control is enabled, filter tenants based on user's organization memberships
      if (controlPlaneTenantId && user?.sub) {
        // Get all organizations the user belongs to on the control plane
        const userOrgs = await fetchAll<{ id: string; name: string }>(
          (params) =>
            getRequestData(ctx).userOrganizations.listUserOrganizations(
              controlPlaneTenantId,
              user.sub,
              params,
            ),
          "organizations",
        );

        // The organization names correspond to tenant IDs the user can access
        // (organization name is set to tenant ID when creating tenant organizations)
        const accessibleTenantIds = userOrgs.map((org) => org.name);

        // If user has no accessible tenants, return empty array
        if (accessibleTenantIds.length === 0) {
          if (include_totals) {
            return ctx.json({
              tenants: [],
              start: 0,
              limit: per_page ?? 50,
              length: 0,
              total: 0,
            });
          }
          return ctx.json({ tenants: [] });
        }

        const pageNum = page ?? 0;
        const perPage = per_page ?? 50;
        const start = pageNum * perPage;

        // A search runs over every accessible tenant and pages the matches.
        // Paging the IDs first would search only one page of memberships, so
        // a tenant further down could never be found. The search itself goes
        // to the adapter alone, then is narrowed to the accessible tenants:
        // not every adapter's query parser takes grouped queries such as
        // `(… OR …) AND (…)`, which also rules out fetchAll's cursor
        // (`(q) AND id:>…`). So it pages by offset with the search as given.
        if (q) {
          const accessible = new Set(accessibleTenantIds);
          const matches: Tenant[] = [];
          for (let searchPage = 0; ; searchPage++) {
            if (searchPage >= SEARCH_MAX_BATCHES) {
              // Better refused than answered as if complete.
              throw new HTTPException(400, {
                message: `The search matches more than ${SEARCH_MAX_BATCHES * SEARCH_BATCH_SIZE} tenants; narrow it down`,
              });
            }
            const batch = await getRequestData(ctx).tenants.list({
              q,
              page: searchPage,
              per_page: SEARCH_BATCH_SIZE,
            });
            for (const tenant of batch.tenants) {
              if (accessible.has(tenant.id)) matches.push(tenant);
            }
            if (batch.tenants.length < SEARCH_BATCH_SIZE) break;
          }
          const pageOfMatches = matches.slice(start, start + perPage);

          if (include_totals) {
            return ctx.json({
              tenants: pageOfMatches,
              start,
              limit: perPage,
              length: pageOfMatches.length,
              total: matches.length,
            });
          }

          return ctx.json({ tenants: pageOfMatches });
        }

        // Without a search, page the accessible tenant IDs
        const totalAccessible = accessibleTenantIds.length;
        const paginatedIds = accessibleTenantIds.slice(start, start + perPage);

        // If this page is beyond the available tenants, return empty array
        if (paginatedIds.length === 0) {
          if (include_totals) {
            return ctx.json({
              tenants: [],
              start,
              limit: perPage,
              length: 0,
              total: totalAccessible,
            });
          }
          return ctx.json({ tenants: [] });
        }

        // Fetch only the tenants for this page by ID
        // Construct a query to filter by the paginated IDs
        const idFilter = paginatedIds.map((id) => `id:${id}`).join(" OR ");

        const result = await getRequestData(ctx).tenants.list({
          q: idFilter,
          per_page: perPage,
          include_totals: false, // We calculate totals from accessibleTenantIds
        });

        if (include_totals) {
          return ctx.json({
            tenants: result.tenants,
            start,
            limit: perPage,
            length: result.tenants.length,
            total: totalAccessible,
          });
        }

        return ctx.json({ tenants: result.tenants });
      }

      // If no access control, return all tenants (for backward compatibility)
      const result = await getRequestData(ctx).tenants.list({
        page,
        per_page,
        include_totals,
        q,
      });

      if (include_totals) {
        return ctx.json({
          tenants: result.tenants,
          start: result.totals?.start ?? 0,
          limit: result.totals?.limit ?? per_page,
          length: result.tenants.length,
          total: result.totals?.length,
        });
      }

      return ctx.json({ tenants: result.tenants });
    },
  );

  // --------------------------------
  // GET /deployment-options - Deployment types new tenants may use
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants"],
      method: "get",
      path: "/deployment-options",
      security: [
        {
          Bearer: [],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: deploymentOptionsSchema,
            },
          },
          description: "The deployment types this cluster can host",
        },
      },
    }),
    async (ctx) => {
      return ctx.json(
        {
          deployment_types: deploymentTypes.allowed,
          default_deployment_type: deploymentTypes.default,
          ...(config.tenantHostTemplate && {
            tenant_host_template: config.tenantHostTemplate,
          }),
        },
        200,
      );
    },
  );

  // --------------------------------
  // POST / - Create a tenant
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants"],
      method: "post",
      path: "/",
      request: {
        body: {
          content: {
            "application/json": {
              schema: createTenantBodySchema,
            },
          },
        },
      },
      security: [
        {
          Bearer: ["create:tenants"],
        },
      ],
      responses: {
        201: {
          content: {
            "application/json": {
              schema: tenantSchema,
            },
          },
          description: "Tenant created",
        },
        400: {
          description: "Validation error",
        },
        409: {
          description: "Tenant with this ID already exists",
        },
      },
    }),
    async (ctx) => {
      // Ensure user is authenticated
      const user = ctx.var.user;
      if (!user?.sub) {
        throw new HTTPException(401, {
          message: "Authentication required to create tenants",
        });
      }

      // `config_sync_*` is written by the sync operation only: a forged hash
      // would make a push look up to date.
      const {
        config_sync_hash: _hash,
        config_synced_at: _syncedAt,
        config_sync: requestedSync,
        deployment_type: requestedDeploymentType,
        ...validBody
      } = ctx.req.valid("json");
      const deploymentType = requestedDeploymentType ?? deploymentTypes.default;
      if (!deploymentTypes.allowed.includes(deploymentType)) {
        throw new HTTPException(400, {
          message: `Deployment type '${deploymentType}' is not available here. Allowed: ${deploymentTypes.allowed.join(", ")}`,
        });
      }
      let body: CreateTenantParams = {
        ...validBody,
        deployment_type: deploymentType,
        // A dispatch worker tenant gets its own D1 unless the caller names
        // another backend.
        ...(deploymentType === "wfp" && !validBody.storage_kind
          ? { storage_kind: "own_d1" as const }
          : {}),
      };
      // Choosing the parent decides whose published config a tenant receives,
      // so a tenant's own admin may not attach it to someone else's tenant.
      if (body.parent_tenant_id && !isControlPlaneCaller(ctx)) {
        throw new HTTPException(403, {
          message: "Only the control plane can set a tenant's parent",
        });
      }
      // `config_sync` is an operator decision: only a control-plane caller may
      // create a tenant that is already in `synced` mode.
      if (requestedSync !== undefined && isControlPlaneCaller(ctx)) {
        body = { ...body, config_sync: requestedSync };
      }

      // Create hook context
      const hookCtx: TenantHookContext = {
        adapters: getRequestData(ctx),
        ctx,
      };

      // Call beforeCreate hook
      if (hooks.tenants?.beforeCreate) {
        body = await hooks.tenants.beforeCreate(hookCtx, body);
      }

      await validateTenantParent({
        tenantId: body.id,
        parentTenantId: body.parent_tenant_id,
        getTenant: (id) => getRequestData(ctx).tenants.get(id),
      });

      // An id that differs from an existing one only in letter case would give
      // two tenants whose members' tokens look the same (organization names are
      // lowercased in a token), so refuse it like a duplicate id.
      if (body.id) {
        const colliding = await findCaseCollidingTenantId(
          getRequestData(ctx).tenants,
          body.id,
        );
        if (colliding) {
          throw new HTTPException(409, {
            message: `Tenant ID '${body.id}' conflicts with the existing tenant '${colliding}': tenant IDs must differ by more than letter case`,
          });
        }
      }

      // Create the tenant - adapter will throw HTTPException(409) if tenant ID already exists
      const tenant = await getRequestData(ctx).tenants.create(body);

      // Call afterCreate hook
      if (hooks.tenants?.afterCreate) {
        await hooks.tenants.afterCreate(hookCtx, tenant);
      }

      config.onConfigSyncChange?.(tenant.id);

      return ctx.json(tenant, 201);
    },
  );

  // --------------------------------
  // DELETE /:id - Delete a tenant
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants"],
      method: "delete",
      path: "/{id}",
      request: {
        params: z.object({
          id: z.string(),
        }),
      },
      security: [
        {
          Bearer: ["delete:tenants"],
        },
      ],
      responses: {
        204: {
          description: "Tenant deleted",
        },
        403: {
          description: "Access denied or cannot delete the control plane",
        },
        404: {
          description: "Tenant not found",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");

      // Get control plane tenant ID from config or from adapters' multiTenancyConfig
      const controlPlaneTenantId =
        config.accessControl?.controlPlaneTenantId ??
        getRequestData(ctx).multiTenancyConfig?.controlPlaneTenantId;

      // Validate access and prevent deleting the control plane
      if (controlPlaneTenantId) {
        const caller = parseCaller(ctx.var.user);

        if (!caller?.sub) {
          throw new HTTPException(401, {
            message: "Authentication required",
          });
        }

        // Cannot delete the control plane
        if (id === controlPlaneTenantId) {
          throw new HTTPException(403, {
            message: "Cannot delete the control plane",
          });
        }

        // Fast path: if the token was minted for this tenant's organization,
        // the auth flow already verified membership. Trust the claim.
        const tokenOrgName = ctx.var.org_name;
        const idLower = id.toLowerCase();
        let hasAccess =
          !!tokenOrgName && tokenOrgName.toLowerCase() === idLower;

        // Super-admin path: a non-org-scoped control-plane token carrying the
        // delete:tenants scope may delete any tenant without per-organization
        // membership. This keeps create and delete symmetric — a global admin
        // can create tenants without being added to their organizations (the
        // provisioning hook deliberately skips adding admin:organizations users
        // to per-tenant orgs), so they must also be able to delete them.
        // Mirrors the "full access" path on the list route. Org-scoped tokens
        // are excluded: their privileges came from an org-scoped role and must
        // not bypass per-organization filtering.
        if (!hasAccess) {
          const tokenIsOrgScoped = Boolean(
            caller.org_id ?? ctx.var.organization_id ?? tokenOrgName,
          );
          const isControlPlaneToken =
            !caller.tenant_id || caller.tenant_id === controlPlaneTenantId;
          if (
            !tokenIsOrgScoped &&
            isControlPlaneToken &&
            callerHasGlobalTenantAdmin(caller)
          ) {
            hasAccess = true;
          }
        }

        // Fallback: look up org memberships on the control plane. Covers
        // tokens issued without an org_name claim (e.g. legacy tokens).
        if (!hasAccess) {
          const userOrgs = await fetchAll<{ id: string; name: string }>(
            (params) =>
              getRequestData(ctx).userOrganizations.listUserOrganizations(
                controlPlaneTenantId,
                caller.sub,
                params,
              ),
            "organizations",
          );
          hasAccess = userOrgs.some(
            (org) => org.name?.toLowerCase() === idLower,
          );
        }

        if (!hasAccess) {
          throw new HTTPException(403, {
            message: "Access denied to this tenant",
          });
        }
      }

      const tenant = await getRequestData(ctx).tenants.get(id);
      if (!tenant) {
        throw new HTTPException(404, {
          message: "Tenant not found",
        });
      }

      // Create hook context
      const hookCtx: TenantHookContext = {
        adapters: getRequestData(ctx),
        ctx,
      };

      // Call beforeDelete hook
      if (hooks.tenants?.beforeDelete) {
        await hooks.tenants.beforeDelete(hookCtx, id);
      }

      // Delete the tenant
      await getRequestData(ctx).tenants.remove(id);

      // Call afterDelete hook
      if (hooks.tenants?.afterDelete) {
        await hooks.tenants.afterDelete(hookCtx, id);
      }

      return ctx.body(null, 204);
    },
  );

  // --------------------------------
  // GET /{id}/config-sync/verify - Compare the tenant's config with its parents'
  // --------------------------------
  if (config.verifyConfigSync) {
    const verify = config.verifyConfigSync;
    app.openapi(
      createRoute({
        tags: ["tenants"],
        method: "get",
        path: "/{id}/config-sync/verify",
        request: {
          params: z.object({ id: z.string() }),
        },
        security: [{ Bearer: ["read:tenants"] }],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({
                  tenant_id: z.string(),
                  config_sync: z.enum([
                    "inherit-on-read",
                    "synced",
                    "detached",
                  ]),
                  method: z.enum([
                    "read-time",
                    "sync-dry-run",
                    "not-applicable",
                  ]),
                  ok: z.boolean(),
                  differences: z.array(
                    z.object({
                      entity: z.string(),
                      key: z.string(),
                      kind: z.enum(["missing", "extra", "changed", "stale"]),
                      fields: z.array(z.string()).optional(),
                    }),
                  ),
                  errors: z.array(z.string()),
                }),
              },
            },
            description:
              "The tenant's config compared with what its parents publish",
          },
          403: { description: "Not allowed to verify this tenant" },
          404: { description: "Tenant not found" },
          502: { description: "The tenant's database could not be reached" },
        },
      }),
      async (ctx) => {
        const { id } = ctx.req.valid("param");
        // The control plane may verify any tenant, a tenant only its own.
        if (id !== ctx.var.tenant_id && !isControlPlaneCaller(ctx)) {
          throw new HTTPException(403, {
            message: "Config can only be verified for your own tenant",
          });
        }
        let result;
        try {
          result = await verify(id);
        } catch (error) {
          // A tenant with its own database that cannot be reached, or a host
          // without a transport for it: nothing was compared. The cause stays
          // in the log; a tenant may call this for itself.
          console.error(
            `[multi-tenancy] config verify failed for "${id}":`,
            error,
          );
          throw new HTTPException(502, {
            message:
              "Could not verify: the tenant's config could not be checked",
          });
        }
        if (!result) {
          throw new HTTPException(404, { message: "Tenant not found" });
        }
        return ctx.json(result);
      },
    );
  }

  // --------------------------------
  // GET /{id}/config-sync - Sync status and where inherited rows come from
  // --------------------------------
  if (config.configSyncStatus) {
    const readStatus = config.configSyncStatus;
    app.openapi(
      createRoute({
        tags: ["tenants"],
        method: "get",
        path: "/{id}/config-sync",
        request: {
          params: z.object({ id: z.string() }),
        },
        security: [{ Bearer: ["read:tenants"] }],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: z.object({
                  tenant_id: z.string(),
                  parent_tenant_id: z.string().nullable(),
                  config_sync: z.enum([
                    "inherit-on-read",
                    "synced",
                    "detached",
                  ]),
                  config_sync_hash: z.string().nullable(),
                  config_synced_at: z.string().nullable(),
                  expected_hash: z.string().nullable(),
                  drifted: z.boolean(),
                  chain: z.array(z.string()),
                  inherited: z.record(z.string(), z.string()),
                }),
              },
            },
            description: "Config sync status of the tenant",
          },
          403: { description: "Not allowed to read this tenant" },
          404: { description: "Tenant not found" },
        },
      }),
      async (ctx) => {
        const { id } = ctx.req.valid("param");
        // The control plane may read any tenant, a tenant only its own.
        if (id !== ctx.var.tenant_id && !isControlPlaneCaller(ctx)) {
          throw new HTTPException(403, {
            message: "Config sync status is only readable for your own tenant",
          });
        }
        const status = await readStatus(id);
        if (!status) {
          throw new HTTPException(404, { message: "Tenant not found" });
        }
        return ctx.json(status);
      },
    );
  }

  // --------------------------------
  // GET /settings - Get current tenant settings
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants", "settings"],
      method: "get",
      path: "/settings",
      request: {
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
      },
      security: [
        {
          Bearer: ["read:tenants"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: tenantSchema,
            },
          },
          description: "Current tenant settings",
        },
      },
    }),
    async (ctx) => {
      const tenant = await getRequestData(ctx).tenants.get(ctx.var.tenant_id);

      if (!tenant) {
        throw new HTTPException(404, {
          message: "Tenant not found",
        });
      }

      return ctx.json({ ...tenant, ...(await computedFields(ctx, tenant.id)) });
    },
  );

  // --------------------------------
  // PATCH /settings - Update current tenant settings
  // --------------------------------
  app.openapi(
    createRoute({
      tags: ["tenants", "settings"],
      method: "patch",
      path: "/settings",
      request: {
        headers: z.object({
          "tenant-id": z.string().optional(),
        }),
        body: {
          content: {
            "application/json": {
              schema: tenantPatchSchema,
            },
          },
        },
      },
      security: [
        {
          Bearer: ["update:tenants"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: tenantSchema,
            },
          },
          description: "Updated tenant settings",
        },
      },
    }),
    async (ctx) => {
      const updates = ctx.req.valid("json");

      // Strip protected system fields that should not be modified
      // `config_sync_*` is written by the sync operation only.
      const {
        id,
        config_sync_hash: _hash,
        config_synced_at: _syncedAt,
        ...sanitizedUpdates
      } = updates;

      // Get existing tenant
      const existingTenant = await getRequestData(ctx).tenants.get(
        ctx.var.tenant_id,
      );

      if (!existingTenant) {
        throw new HTTPException(404, {
          message: "Tenant not found",
        });
      }

      // Switching how a tenant inherits config is an operator decision: a
      // child tenant's admin must not be able to turn read-time inheritance
      // back on. The admin UI sends the whole record, so an unchanged value
      // is fine.
      if (
        "config_sync" in sanitizedUpdates &&
        (sanitizedUpdates.config_sync ?? "inherit-on-read") !==
          (existingTenant.config_sync ?? "inherit-on-read") &&
        !isControlPlaneCaller(ctx)
      ) {
        throw new HTTPException(403, {
          message:
            "Only the control plane can change a tenant's config_sync mode",
        });
      }

      // A tenant can't be moved onto a deployment type this cluster can't host.
      // The admin UI sends the whole record, so an unchanged value is fine.
      if (
        sanitizedUpdates.deployment_type !== undefined &&
        sanitizedUpdates.deployment_type !==
          (existingTenant.deployment_type ?? "shared") &&
        !deploymentTypes.allowed.includes(sanitizedUpdates.deployment_type)
      ) {
        throw new HTTPException(400, {
          message: `Deployment type '${sanitizedUpdates.deployment_type}' is not available here. Allowed: ${deploymentTypes.allowed.join(", ")}`,
        });
      }

      // The default client anchors interactive tenant-level flows, so it must
      // reference an existing, interactive client — never an M2M client (#1007).
      if ("default_client_id" in sanitizedUpdates) {
        const next = sanitizedUpdates.default_client_id;
        if (typeof next === "string" && next.length > 0) {
          const client = await getRequestData(ctx).clients.get(
            ctx.var.tenant_id,
            next,
          );
          if (!client) {
            throw new HTTPException(400, {
              message: `Client with id '${next}' not found`,
            });
          }
          if (!isInteractiveClient(client)) {
            throw new HTTPException(400, {
              message: `Client '${next}' is not an interactive client and cannot be used as the default client`,
            });
          }
        }
      }

      if ("parent_tenant_id" in sanitizedUpdates) {
        // An unchanged value is fine: the admin UI sends the whole record.
        if (
          (sanitizedUpdates.parent_tenant_id ?? null) !==
            (existingTenant.parent_tenant_id ?? null) &&
          !isControlPlaneCaller(ctx)
        ) {
          throw new HTTPException(403, {
            message: "Only the control plane can change a tenant's parent",
          });
        }
        await validateTenantParent({
          tenantId: ctx.var.tenant_id,
          parentTenantId: sanitizedUpdates.parent_tenant_id,
          getTenant: (id) => getRequestData(ctx).tenants.get(id),
          getChildren: async (id) =>
            (
              await fetchAll<{ id: string; parent_tenant_id?: string | null }>(
                (p) => getRequestData(ctx).tenants.list(p),
                "tenants",
              )
            )
              .filter((t) => t.parent_tenant_id === id)
              .map((t) => t.id),
        });
      }

      // Deep merge with updates to preserve nested object properties
      const mergedTenant = deepMergePatch(existingTenant, sanitizedUpdates);

      await getRequestData(ctx).tenants.update(ctx.var.tenant_id, mergedTenant);

      // Return the updated tenant
      if ("config_sync" in sanitizedUpdates) {
        config.onConfigSyncChange?.(ctx.var.tenant_id);
      }

      const updatedTenant = await getRequestData(ctx).tenants.get(
        ctx.var.tenant_id,
      );

      if (!updatedTenant) {
        throw new HTTPException(500, {
          message: "Failed to retrieve updated tenant",
        });
      }

      return ctx.json({
        ...updatedTenant,
        ...(await computedFields(ctx, updatedTenant.id)),
      });
    },
  );

  // --------------------------------
  // PATCH /:id - Change a tenant's operator-owned settings
  // --------------------------------
  // Registered after `/settings` so that path keeps meaning "the current
  // tenant". Unlike `/settings`, which acts on the tenant named by the request
  // (and is forwarded to that tenant's own worker when it runs apart), this
  // addresses the tenant's record on the control plane by id. The sync mode and
  // the parent are kept there: the sync reads them from the control plane's row,
  // so a change written anywhere else would not take effect.
  app.openapi(
    createRoute({
      tags: ["tenants"],
      method: "patch",
      path: "/{id}",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: tenantPatchSchema.pick({
                config_sync: true,
                parent_tenant_id: true,
              }),
            },
          },
        },
      },
      security: [
        {
          Bearer: ["update:tenants"],
        },
      ],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: tenantSchema,
            },
          },
          description: "Updated tenant",
        },
        403: {
          description: "Only the control plane can change these settings",
        },
        404: {
          description: "Tenant not found",
        },
      },
    }),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const updates = ctx.req.valid("json");

      if (!isControlPlaneCaller(ctx)) {
        throw new HTTPException(403, {
          message:
            "Only the control plane can change a tenant's config_sync mode or parent",
        });
      }

      const tenants = getRequestData(ctx).tenants;
      const existingTenant = await tenants.get(id);
      if (!existingTenant) {
        throw new HTTPException(404, { message: "Tenant not found" });
      }

      // Only what the body names is written; the rest of the record is left
      // as it is.
      const changes: { config_sync?: typeof existingTenant.config_sync } & {
        parent_tenant_id?: typeof existingTenant.parent_tenant_id;
      } = {};
      if ("config_sync" in updates) changes.config_sync = updates.config_sync;
      if ("parent_tenant_id" in updates) {
        await validateTenantParent({
          tenantId: id,
          parentTenantId: updates.parent_tenant_id,
          getTenant: (tenantId) => tenants.get(tenantId),
          getChildren: async (parentId) =>
            (
              await fetchAll<{ id: string; parent_tenant_id?: string | null }>(
                (p) => tenants.list(p),
                "tenants",
              )
            )
              .filter((t) => t.parent_tenant_id === parentId)
              .map((t) => t.id),
        });
        changes.parent_tenant_id = updates.parent_tenant_id;
      }

      if (Object.keys(changes).length > 0) {
        await tenants.update(id, changes);
        if ("config_sync" in changes) {
          config.onConfigSyncChange?.(id);
        }
      }

      const updatedTenant = await tenants.get(id);
      if (!updatedTenant) {
        throw new HTTPException(500, {
          message: "Failed to retrieve updated tenant",
        });
      }

      return ctx.json({
        ...updatedTenant,
        ...(await computedFields(ctx, updatedTenant.id)),
      });
    },
  );

  return app;
}
