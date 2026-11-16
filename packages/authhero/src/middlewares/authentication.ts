import { OpenAPIHono } from "@hono/zod-openapi";
import { Context, Next } from "hono";
import { Bindings, Variables } from "../types";
import { HTTPException } from "hono/http-exception";
import { JSONHTTPException } from "../errors/json-http-exception";
import { authErrors, notFound } from "../errors/management-api-error";
import { decode } from "hono/jwt";
import { validateJwtToken } from "../utils/jwt";
import { extractBearerToken } from "../utils/auth-header";

/**
 * Management API audience for cross-tenant operations.
 * Used when managing tenants from the main tenant with org-scoped tokens.
 */
export const MANAGEMENT_API_AUDIENCE = "urn:authhero:management";

/**
 * Routes of the multi-tenancy tenants router (`/tenants`, `/tenants/{id}` and
 * what hangs off it). They run in the control plane's context and check access
 * per organization themselves, so an organization-scoped control-plane token may
 * reach them there. Three paths under `/tenants` are not part of that:
 * `/tenants/{id}/operations` and `/tenants/{id}/config-sync` do no
 * per-organization check, and `/tenants/settings` reads and writes the settings
 * of the tenant the request is in, which in the control plane's context would be
 * the control plane's own.
 */
function isTenantsRouterPath(path: string): boolean {
  if (path === "/tenants") return true;
  if (!path.startsWith("/tenants/")) return false;
  // `/tenants/{id}/operations` and `/tenants/{id}/config-sync` (and `/verify`)
  // only check that the request is in the control plane's context, or that the
  // id is the request's own tenant, not that the caller belongs to the target
  // tenant's organization. In the control plane's context that means the control
  // plane itself, so they stay bound.
  if (/^\/tenants\/[^/]+\/(operations|config-sync)(\/|$)/.test(path))
    return false;
  return path !== "/tenants/settings" && !path.startsWith("/tenants/settings/");
}

function convertRouteSyntax(route: string) {
  return route.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

/**
 * This registeres the authentication middleware. As it needs to read the OpenAPI definition, it needs to have a reference to the app.
 *
 * `requireManagementAudience` enables the defense-in-depth check that the
 * token's `aud` includes the management API audience. It must be enabled
 * for the management API and left off for everything else (the `/userinfo`
 * endpoint, for example, takes any access token issued by this tenant).
 *
 * `relaxManagementAudience` downgrades that audience check from a hard
 * rejection to a `console.warn`, letting tokens issued for other audiences
 * still pass. TRANSITIONAL: use only while migrating clients to request
 * the management audience; flip back off once warnings stop appearing.
 *
 * `additionalManagementAudiences` extends the set of accepted audiences
 * beyond the built-in `urn:authhero:management`. The resolver receives the
 * token's `tenant_id` and returns the list of audiences accepted for that
 * token, so a per-tenant identifier (e.g.
 * `https://${tenant_id}.token.example.com/v2/api/`) can be constructed at
 * request time alongside any global legacy identifiers.
 *
 * `additionalIssuers` extends the set of accepted token issuers beyond the
 * deployment's own `getIssuer(env, custom_domain)`. The resolver receives the
 * token's `tenant_id` and returns the issuers accepted for that token, so a
 * control-plane issuer can be accepted on forwarded admin requests whose
 * per-tenant worker has a different `env.ISSUER`. The default issuer is always
 * accepted; the resolver is purely additive and may return `[]` to refuse.
 */
export type ManagementAudienceResolver = (params: {
  tenant_id?: string;
}) => string[] | Promise<string[]>;

/**
 * Resolver returning the issuers accepted **in addition to** the deployment's
 * own issuer when verifying bearer JWTs. Receives the token's `tenant_id` so a
 * per-tenant or control-plane issuer can be constructed at request time.
 * Returning `[]` keeps the strict single-issuer behavior for that token.
 */
export type IssuerResolver = (params: {
  tenant_id?: string;
}) => string[] | Promise<string[]>;

export interface AuthMiddlewareOptions {
  requireManagementAudience?: boolean;
  relaxManagementAudience?: boolean;
  additionalManagementAudiences?: ManagementAudienceResolver;
  additionalIssuers?: IssuerResolver;
}

// For a scope of the form `verb:resource` (e.g. `read:users`) also accept the
// reversed `resource:verb` form (`users:read`). Auth0 uses the former; some
// clients in the wild use the latter, so we treat them as equivalent rather
// than forcing every caller to reissue tokens.
export function scopeForms(scope: string): string[] {
  const parts = scope.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return [scope];
  }
  const reversed = `${parts[1]}:${parts[0]}`;
  return reversed === scope ? [scope] : [scope, reversed];
}

export function createAuthMiddleware(
  app: OpenAPIHono<{ Bindings: Bindings; Variables: Variables }>,
  options: AuthMiddlewareOptions = {},
) {
  const requireManagementAudience = options.requireManagementAudience ?? false;
  const relaxManagementAudience = options.relaxManagementAudience ?? false;
  const additionalManagementAudiences = options.additionalManagementAudiences;
  const additionalIssuers = options.additionalIssuers;
  return async (
    ctx: Context<{ Bindings: Bindings; Variables }>,
    next: Next,
  ) => {
    const matchedRoute = ctx.req.matchedRoutes.find(
      (route) =>
        route.method.toUpperCase() === ctx.req.method && route.path !== "/*",
    );

    if (!matchedRoute) {
      return await next();
    }

    // Since the OpenAPI registry stores routes with their full paths (including basePaths),
    // we can directly use the matched route path to find the definition
    const matchedPath = convertRouteSyntax(matchedRoute.path);

    // Extract the path relative to /api/v2 for matching against OpenAPI definitions
    // The registry stores paths without the /api/v2 prefix
    const apiPrefix = "/api/v2";
    const relativePath = matchedPath.startsWith(apiPrefix)
      ? matchedPath.slice(apiPrefix.length) || "/"
      : matchedPath;

    const definition = app.openAPIRegistry.definitions.find(
      (def) =>
        "route" in def &&
        def.route.path === relativePath &&
        def.route.method.toUpperCase() === ctx.req.method.toUpperCase(),
    );

    if (definition && "route" in definition) {
      const requiredPermissions = definition.route.security?.[0]?.Bearer;

      // Bail if Bearer is not defined in security (undefined means no auth required)
      // Note: Bearer: [] means "authentication required but no specific scopes"
      if (requiredPermissions === undefined) {
        return await next();
      }

      const bearer = extractBearerToken(ctx.req.header("authorization"));
      if (!bearer) {
        throw authErrors.missingAuthentication();
      }

      try {
        // Resolve any host-app-provided additional issuers before verifying.
        // The issuer check happens inside validateJwtToken, so the resolver
        // needs the token's tenant_id up front — read it from the unverified
        // payload. This only widens the set of candidate issuers; the token
        // must still carry a valid signature AND an `iss` in the accepted set,
        // so the unverified read can't be leveraged on its own.
        let resolvedAdditionalIssuers: string[] | undefined;
        if (additionalIssuers) {
          const { payload: unverifiedPayload } = decode(bearer);
          const tenantIdForIssuer =
            typeof unverifiedPayload?.tenant_id === "string"
              ? unverifiedPayload.tenant_id
              : undefined;
          resolvedAdditionalIssuers = await additionalIssuers({
            tenant_id: tenantIdForIssuer,
          });
        }

        const tokenPayload = await validateJwtToken(ctx, bearer, {
          additionalIssuers: resolvedAdditionalIssuers,
        });

        // Populate principal context from the validated token before any
        // authorization checks below. The token is cryptographically valid by
        // this point; the checks that follow gate access, not authenticity.
        // Setting these here lets audit logs attribute failed authorizations
        // (Invalid audience, cross-tenant denial, missing scope) to the actual
        // calling principal instead of recording an anonymous failure.
        ctx.set("user_id", tokenPayload.sub);
        ctx.set("user", tokenPayload);
        if (tokenPayload.azp) {
          ctx.set("client_id", tokenPayload.azp);
          ctx.set("client_id_from_token", true);
        }
        if (tokenPayload.org_name) {
          ctx.set("org_name", tokenPayload.org_name);
        }
        if (tokenPayload.org_id) {
          ctx.set("organization_id", tokenPayload.org_id);
        }
        if (!ctx.var.tenant_id && tokenPayload.tenant_id) {
          ctx.set("tenant_id", tokenPayload.tenant_id);
        }

        if (requireManagementAudience) {
          // Defense in depth: require the token's audience to be the
          // management API resource server. Without this check a token issued
          // for any other audience — including one minted with attacker-chosen
          // scopes via an unregistered audience — would be accepted as long as
          // it carried a matching scope/permission string.
          const aud = tokenPayload.aud;
          const tokenAudiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
          const tokenTenantIdForAud =
            typeof tokenPayload.tenant_id === "string"
              ? tokenPayload.tenant_id
              : undefined;
          const extraAudiences = additionalManagementAudiences
            ? await additionalManagementAudiences({
                tenant_id: tokenTenantIdForAud,
              })
            : [];
          const acceptedAudiences = new Set<string>([
            MANAGEMENT_API_AUDIENCE,
            ...extraAudiences,
          ]);
          if (!tokenAudiences.some((a) => acceptedAudiences.has(a))) {
            if (relaxManagementAudience) {
              // TRANSITIONAL: client hasn't been updated to request the
              // management audience yet. Log so operators can identify the
              // remaining offenders and eventually flip the flag back off.
              console.warn(
                `[authhero] management API accepted token without management audience (relaxManagementAudience=true): sub=${tokenPayload.sub ?? "unknown"} aud=${JSON.stringify(aud)}`,
              );
            } else {
              throw new JSONHTTPException(403, {
                message: "Invalid audience",
              });
            }
          }

          // Cross-tenant guard: the management API resolves `tenant_id` from
          // the `tenant-id` request header (tenantMiddleware runs first). If
          // an authenticated token belongs to tenant A and the request targets
          // tenant B, only tokens issued by the deployment's control-plane
          // tenant may make that hop. Without this check, any admin token from
          // any tenant could be used to operate on any other tenant by
          // setting the `tenant-id` header.
          const tokenTenantId =
            typeof tokenPayload.tenant_id === "string"
              ? tokenPayload.tenant_id
              : undefined;
          const requestTenantId = ctx.var.tenant_id;
          if (
            tokenTenantId &&
            requestTenantId &&
            tokenTenantId !== requestTenantId
          ) {
            const cpId = ctx.env.data?.multiTenancyConfig?.controlPlaneTenantId;
            // Multi-tenant deployments must configure a control plane.
            // Single-tenant deployments shouldn't see this branch in practice
            // (there's only one tenant) — fail closed if we land here without
            // a configured control plane.
            if (!cpId || tokenTenantId !== cpId) {
              throw new JSONHTTPException(403, {
                message:
                  "Cross-tenant management requires a control-plane token",
              });
            }
            // A same-tenant token implies its tenant exists; a control-plane
            // token can name any tenant, so check it here rather than letting
            // a typo'd tenant-id surface as a missing user/client/etc.
            // A failing lookup is a server error: the catch below would
            // otherwise turn it into 401 invalid_token.
            const tenant = await ctx.var.data.tenants
              .get(requestTenantId)
              .catch((cause: unknown) => {
                throw new HTTPException(500, {
                  message: "Failed to look up tenant",
                  cause,
                });
              });
            if (!tenant) {
              throw notFound.tenant();
            }
          }

          // Organization binding: a control-plane token that carries an
          // organization claim is bound to the tenant that organization names.
          // On the control plane an organization is a tenant (its name is the
          // tenant id), and the token carries that organization role's
          // permissions, so it may act on that tenant only. Without this a
          // member of one tenant's organization could name the control plane,
          // or any other tenant, in `tenant-id` and use those permissions
          // there. The one exception is the tenants router in the control
          // plane's own context, which does its own per-organization checks.
          const controlPlaneId =
            ctx.env.data?.multiTenancyConfig?.controlPlaneTenantId;
          const orgName =
            typeof tokenPayload.org_name === "string"
              ? tokenPayload.org_name
              : undefined;
          const orgId =
            typeof tokenPayload.org_id === "string"
              ? tokenPayload.org_id
              : undefined;
          if (
            controlPlaneId &&
            tokenTenantId === controlPlaneId &&
            requestTenantId &&
            (orgName || orgId)
          ) {
            // The organization's name when only its id is in the token. A
            // failed lookup is a server error, like the tenant lookup above.
            const boundTenantId =
              orgName ??
              (
                await ctx.env.data.organizations
                  .get(controlPlaneId, orgId!)
                  .catch((cause: unknown) => {
                    throw new HTTPException(500, {
                      message: "Failed to look up organization",
                      cause,
                    });
                  })
              )?.name;
            const isBound =
              !!boundTenantId &&
              boundTenantId.toLowerCase() === requestTenantId.toLowerCase();
            const isTenantsRouter =
              requestTenantId === controlPlaneId &&
              isTenantsRouterPath(relativePath);
            // The tenants router tells an organization's own tenant apart by
            // `org_name`, which an `org_id`-only token does not carry.
            if (isTenantsRouter && boundTenantId && !ctx.var.org_name) {
              ctx.set("org_name", boundTenantId);
            }
            // An organization that cannot be resolved is refused everywhere,
            // the tenants router included.
            if (!isBound && (!isTenantsRouter || !boundTenantId)) {
              throw new JSONHTTPException(403, {
                // The wording matches the WFP tenant worker's own guard.
                message: boundTenantId
                  ? `This token is for another tenant's organization ("${boundTenantId}"), not "${requestTenantId}"`
                  : "An organization token must belong to a tenant's organization",
              });
            }
          }
        }

        const permissions = Array.isArray(tokenPayload.permissions)
          ? tokenPayload.permissions
          : [];
        const scopes =
          typeof tokenPayload.scope === "string"
            ? tokenPayload.scope.split(" ")
            : Array.isArray(tokenPayload.scope)
              ? tokenPayload.scope
              : [];

        if (requiredPermissions.length) {
          const acceptedForms = requiredPermissions.flatMap(scopeForms);
          const hasMatch =
            acceptedForms.some((scope) => permissions.includes(scope)) ||
            acceptedForms.some((scope) => scopes.includes(scope));
          if (!hasMatch) {
            throw authErrors.insufficientScope(requiredPermissions);
          }
        }
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw authErrors.invalidToken();
      }
    }

    // If we can't find a matching route or definition we pass on the request
    return await next();
  };
}
