import type { MiddlewareHandler } from "hono";

/** What the guard reads from the Worker's environment. */
export interface OrgGuardEnv {
  /** The control plane's tenant id; its tokens carry it as `tenant_id`. */
  CONTROL_PLANE_TENANT_ID: string;
  /** The tenant this Worker serves, when it was provisioned with one. */
  TENANT_ID?: string;
}

/**
 * Keeps a control plane token that is scoped to an organization from reaching a
 * tenant other than its own.
 *
 * A member of a tenant's team holds a control plane token (`tenant_id` is the
 * control plane's) with the organization the control plane put in it:
 * `org_name` is the tenant's id. The control plane does not check a call it
 * forwards here, so this Worker is the only gate, and the core cross-tenant
 * guard only asks whether the token comes from the control plane. This checks
 * the other half: that the organization in the token is this tenant's own.
 *
 * A control plane token with no organization (an operator, or a machine client
 * such as the one CI uses) passes: it is a platform credential, not a tenant's.
 * A token with an organization id but no `org_name` is refused, since it cannot
 * be matched with anything.
 *
 * The tenant is `TENANT_ID` and nothing else: the request's own tenant comes
 * from a header the caller controls, so it cannot say which tenant this Worker
 * is. A Worker without `TENANT_ID` refuses organization-scoped tokens.
 *
 * It answers the refusal itself instead of throwing an `HTTPException`: this
 * package bundles its own copy of Hono, so authhero's error handler would not
 * recognise the class and turn the `403` into a `500`.
 */
export function controlPlaneOrgGuard(env: OrgGuardEnv): MiddlewareHandler {
  return async (c, next) => {
    const { user, tenant_id: requestTenantId } = c.var as {
      user?: { tenant_id?: unknown; org_id?: unknown; org_name?: unknown };
      tenant_id?: string;
    };
    const fromControlPlane =
      typeof user?.tenant_id === "string" &&
      user.tenant_id === env.CONTROL_PLANE_TENANT_ID;
    const hasOrganization = Boolean(user?.org_id || user?.org_name);

    if (fromControlPlane && hasOrganization) {
      const tenant = env.TENANT_ID;
      // Both halves must hold: the token is for this tenant's organization,
      // and the request resolved to this tenant too. A `tenant-id` header
      // naming another tenant in this database must not be reachable with it.
      if (
        !tenant ||
        user?.org_name !== tenant ||
        (requestTenantId !== undefined && requestTenantId !== tenant)
      ) {
        console.error(
          `[wfp-tenant] control plane token for organization "${String(
            user?.org_name ?? user?.org_id,
          )}" refused on tenant "${tenant ?? "unknown"}"`,
        );
        return c.json(
          {
            statusCode: 403,
            error: "Forbidden",
            message: "This token is for another tenant's organization",
          },
          403,
        );
      }
    }

    return next();
  };
}
