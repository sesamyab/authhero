import {
  CreateTenantParams,
  Tenant,
  MANAGEMENT_API_SCOPES,
  MANAGEMENT_API_AUDIENCE,
  provisionDefaultClients,
} from "authhero";

/**
 * Generates the default audience URN for a tenant.
 * @param tenantId - The tenant ID
 * @returns The audience URN in the format `urn:authhero:tenant:{tenantId}`
 */
function getTenantAudience(tenantId: string): string {
  return `urn:authhero:tenant:${tenantId.toLowerCase()}`;
}
import {
  MultiTenancyConfig,
  TenantEntityHooks,
  TenantHookContext,
} from "../types";
import { runRecordedTenantOperation } from "../operations";
import {
  ADMIN_REQUIRES_SCOPES,
  DEFAULT_ADMIN_ROLE_NAME,
  DEFAULT_OWNER_ROLE_NAME,
  ensureRoleWithScopes,
  globalManagementPermissions,
  tenantOwnerScopes,
} from "./tenant-roles";

/**
 * What `beforeCreate` read for a request, so `afterCreate` reads nothing a
 * second time after the tenant row exists: a failure then would leave the
 * tenant behind. The creator's roles, and whether the creator already holds the
 * global `admin:organizations`. Keyed by the request's context, one create each.
 */
type PreflightResult = Awaited<ReturnType<typeof resolveCreatorRoles>> & {
  hasGlobalOrgAdmin?: boolean;
};
const preflight = new WeakMap<object, PreflightResult>();

/**
 * Creates hooks for tenant provisioning and deprovisioning.
 *
 * This handles:
 * - Setting the correct audience for new tenants (urn:authhero:tenant:{id})
 * - Creating organizations on the control plane when a new tenant is created
 * - Provisioning databases for new tenants
 * - Cleaning up organizations and databases when tenants are deleted
 *
 * @param config - Multi-tenancy configuration
 * @returns Tenant entity hooks for lifecycle events
 */
export function createProvisioningHooks(
  config: MultiTenancyConfig,
): TenantEntityHooks {
  // The owner role is the admin role minus the operator-only scopes. With the
  // same name both would be one role, and a self-service creator would get
  // every scope. Refuse that before any tenant or role is written.
  if (config.accessControl) {
    const adminName =
      config.accessControl.adminRoleName ?? DEFAULT_ADMIN_ROLE_NAME;
    const ownerName =
      config.accessControl.ownerRoleName ?? DEFAULT_OWNER_ROLE_NAME;
    if (adminName === ownerName) {
      throw new Error(
        `ownerRoleName and adminRoleName must differ (both are "${adminName}")`,
      );
    }
    if (
      config.tenantCreationLimits &&
      config.accessControl.addCreatorToOrganization === false
    ) {
      throw new Error(
        "tenantCreationLimits needs the creator added to the tenant's organization: " +
          "addCreatorToOrganization: false means no ownership is recorded and the limit would never apply",
      );
    }
    // The limit counts tenants by the owner role. Without managed roles no
    // creator gets it, the count stays at zero and the limit never applies.
    if (
      config.tenantCreationLimits &&
      !config.accessControl.issuer &&
      !config.accessControl.provisionRoles
    ) {
      throw new Error(
        "tenantCreationLimits needs managed tenant roles: set accessControl.issuer or accessControl.provisionRoles, " +
          "otherwise no creator gets the owner role the limit counts and it would never apply",
      );
    }
  }

  return {
    async beforeCreate(
      ctx: TenantHookContext,
      params: CreateTenantParams,
    ): Promise<CreateTenantParams> {
      // Read what the creator's role depends on before anything is written.
      // The roles are shared and idempotent, so doing it here costs nothing,
      // and a failure now leaves no tenant or organization behind.
      if (config.accessControl && ctx.ctx?.var.user?.sub) {
        const userId = ctx.ctx.var.user.sub;
        const { controlPlaneTenantId, addCreatorToOrganization = true } =
          config.accessControl;
        preflight.set(ctx.ctx, {
          ...(await resolveCreatorRoles(ctx, config.accessControl, userId)),
          ...(addCreatorToOrganization
            ? {
                hasGlobalOrgAdmin: await userHasGlobalOrgAdminPermission(
                  ctx,
                  controlPlaneTenantId,
                  userId,
                ),
              }
            : {}),
        });
      }

      // Set the audience to the tenant-specific URN if not already set
      // This ensures child tenants use urn:authhero:tenant:{id} as their audience
      if (!params.audience && params.id) {
        return {
          ...params,
          audience: getTenantAudience(params.id),
        };
      }
      return params;
    },

    async afterCreate(ctx: TenantHookContext, tenant: Tenant): Promise<void> {
      const { accessControl, databaseIsolation } = config;

      // 1. Create organization on control plane for access control
      if (accessControl && ctx.ctx) {
        await createOrganizationForTenant(ctx, tenant, accessControl);
      }

      // 2. Provision database if isolation is enabled. When the control
      // plane carries the tenant-operations adapters (issue #1026), the
      // provision run is recorded as an operation with step events;
      // otherwise it runs exactly as before. Hooks that create their own
      // operation rows (the durable workflow hook) opt out via
      // `recordProvisionOperations: false`.
      if (databaseIsolation?.onProvision) {
        const onProvision = databaseIsolation.onProvision;
        if (databaseIsolation.recordProvisionOperations === false) {
          await onProvision(tenant.id);
        } else {
          await runRecordedTenantOperation(
            ctx.adapters,
            {
              kind: "provision",
              tenant_id: tenant.id,
              initiated_by: ctx.ctx?.var.user?.sub,
            },
            (report) => onProvision(tenant.id, report),
          );
        }
      } else {
        // 3. Provision a default interactive client (+ M2M Management API
        // client) so the tenant has a working anchor for tenant-level flows
        // by construction (#1007). Only for pooled tenants: when database
        // isolation is on, the tenant's own DB is seeded via `onProvision`
        // (which runs `seed`, itself calling `provisionDefaultClients`), so
        // provisioning here would write to the wrong database.
        try {
          await provisionDefaultClients(ctx.adapters, tenant.id, {
            managementApiIdentifier: MANAGEMENT_API_AUDIENCE,
            managementApiScopes: MANAGEMENT_API_SCOPES,
          });
        } catch (error) {
          // Don't swallow this: a tenant left without its default interactive
          // client/M2M setup can't anchor tenant-level flows (see #1007), so
          // surface the failure instead of reporting a healthy tenant.
          console.warn(
            `Failed to provision default clients for tenant ${tenant.id}:`,
            error,
          );
          throw error;
        }
      }
    },

    async beforeDelete(
      ctx: TenantHookContext,
      tenantId: string,
    ): Promise<void> {
      const { accessControl, databaseIsolation } = config;

      // 1. Remove organization from control plane
      if (accessControl) {
        try {
          // Find the organization by name (which matches tenant ID)
          const orgs = await ctx.adapters.organizations.list(
            accessControl.controlPlaneTenantId,
          );
          const org = orgs.organizations.find((o) => o.name === tenantId);

          if (org) {
            await ctx.adapters.organizations.remove(
              accessControl.controlPlaneTenantId,
              org.id,
            );
          }
        } catch (error) {
          console.warn(
            `Failed to remove organization for tenant ${tenantId}:`,
            error,
          );
        }
      }

      // 2. Deprovision database if isolation is enabled
      if (databaseIsolation?.onDeprovision) {
        try {
          await databaseIsolation.onDeprovision(tenantId);
        } catch (error) {
          console.warn(
            `Failed to deprovision database for tenant ${tenantId}:`,
            error,
          );
        }
      }
    },
  };
}

/**
 * Resolves the roles a new tenant's creator needs, creating or topping them up
 * as needed: the admin role (when roles are managed, that is an `issuer` is set
 * or `provisionRoles` is on) and the role the creator will get: the admin role
 * for a creator who already holds the operator scopes globally, the narrower
 * owner role for anyone else. Safe to call more than once.
 */
async function resolveCreatorRoles(
  ctx: TenantHookContext,
  accessControl: NonNullable<MultiTenancyConfig["accessControl"]>,
  userId: string | undefined,
): Promise<{ adminRoleId?: string; creatorRoleId?: string }> {
  const {
    controlPlaneTenantId,
    issuer,
    adminRoleName = DEFAULT_ADMIN_ROLE_NAME,
    adminRoleDescription = "Full access to all tenant management operations",
    addCreatorToOrganization = true,
    provisionRoles = false,
    ownerRoleName = DEFAULT_OWNER_ROLE_NAME,
    ownerRoleDescription = "Manages the tenant's own configuration, users and applications",
  } = accessControl;

  if (!issuer && !provisionRoles) return {};

  // The admin role has every management scope, topped up with scopes added
  // since it was created.
  const adminRoleId = await ensureRoleWithScopes(
    ctx.adapters,
    controlPlaneTenantId,
    {
      name: adminRoleName,
      description: adminRoleDescription,
      scopes: MANAGEMENT_API_SCOPES.map((scope) => scope.value),
    },
  );
  // The owner role is kept up to date on every creation too, whoever the
  // creator is, so an existing one picks up scopes added since it was created.
  const ownerRoleId = await ensureRoleWithScopes(
    ctx.adapters,
    controlPlaneTenantId,
    {
      name: ownerRoleName,
      description: ownerRoleDescription,
      scopes: tenantOwnerScopes(),
    },
  );
  if (!addCreatorToOrganization || !userId) return { adminRoleId };

  // The admin role only for a creator who already holds the operator scopes
  // globally, so the role in the tenant's organization never grants more than
  // they had. Everyone else, a self-service creator included, gets the owner
  // role.
  const held = await globalManagementPermissions(
    ctx.adapters,
    controlPlaneTenantId,
    userId,
  );
  const isOperator = ADMIN_REQUIRES_SCOPES.every((scope) => held.has(scope));
  const creatorRoleId = isOperator ? adminRoleId : ownerRoleId;
  return { adminRoleId, creatorRoleId };
}

/**
 * Creates an organization on the control plane for a new tenant.
 * Also creates/assigns the admin role and adds the creator to the organization.
 */
async function createOrganizationForTenant(
  ctx: TenantHookContext,
  tenant: Tenant,
  accessControl: NonNullable<MultiTenancyConfig["accessControl"]>,
): Promise<void> {
  const {
    controlPlaneTenantId,
    defaultPermissions,
    defaultRoles,
    addCreatorToOrganization = true,
  } = accessControl;

  // What `beforeCreate` already read, so nothing that can fail runs after the
  // tenant row exists. Read here only when that did not run.
  const cached = ctx.ctx ? preflight.get(ctx.ctx) : undefined;
  if (ctx.ctx) preflight.delete(ctx.ctx);
  const { creatorRoleId } =
    cached ??
    (await resolveCreatorRoles(ctx, accessControl, ctx.ctx?.var.user?.sub));

  // Create organization with tenant ID as the name (let the adapter generate the ID)
  // The org name is used for access control - tokens include org_name which matches tenant ID
  // when allow_organization_name_in_authentication_api is enabled on the tenant
  const organization = await ctx.adapters.organizations.create(
    controlPlaneTenantId,
    {
      name: tenant.id,
      display_name: tenant.friendly_name || tenant.id,
    },
  );

  // Add the creator to the organization and assign the role
  // Skip if the user has admin:organizations permission (they can access any org without membership)
  if (addCreatorToOrganization && ctx.ctx) {
    const user = ctx.ctx.var.user;
    if (user?.sub) {
      // Check if user has admin:organizations at the global level
      const hasGlobalOrgAdmin =
        cached?.hasGlobalOrgAdmin ??
        (await userHasGlobalOrgAdminPermission(
          ctx,
          controlPlaneTenantId,
          user.sub,
        ));

      // Only add user to organization if they don't have global admin:organizations
      if (!hasGlobalOrgAdmin) {
        try {
          // Add user to the organization
          await ctx.adapters.userOrganizations.create(controlPlaneTenantId, {
            user_id: user.sub,
            organization_id: organization.id,
          });

          // Assign the role to the user for this organization (only if roles
          // are managed)
          if (creatorRoleId) {
            await ctx.adapters.userRoles.create(
              controlPlaneTenantId,
              user.sub,
              creatorRoleId,
              organization.id, // organizationId
            );
          }
        } catch (error) {
          console.warn(
            `Failed to add creator ${user.sub} to organization ${organization.id}:`,
            error,
          );
        }
      }
    }
  }

  // Assign default roles if configured
  if (defaultRoles && defaultRoles.length > 0) {
    // Note: Role assignment would require additional API calls
    // This is a placeholder for the actual implementation
    console.log(
      `Would assign roles ${defaultRoles.join(", ")} to organization ${organization.id}`,
    );
  }

  // Grant default permissions if configured
  if (defaultPermissions && defaultPermissions.length > 0) {
    // Note: Permission assignment would require additional API calls
    // This is a placeholder for the actual implementation
    console.log(
      `Would grant permissions ${defaultPermissions.join(", ")} to organization ${organization.id}`,
    );
  }
}

/**
 * Checks if a user has the admin:organizations permission at the global (tenant) level.
 * This is used to determine if the user should be added to organizations or not.
 */
async function userHasGlobalOrgAdminPermission(
  ctx: TenantHookContext,
  controlPlaneTenantId: string,
  userId: string,
): Promise<boolean> {
  // Get user's global roles (not organization-scoped)
  const globalRoles = await ctx.adapters.userRoles.list(
    controlPlaneTenantId,
    userId,
    undefined,
    "", // Empty string for global roles
  );

  // Check if any global role has admin:organizations permission
  for (const role of globalRoles) {
    const rolePermissions = await ctx.adapters.rolePermissions.list(
      controlPlaneTenantId,
      role.id,
      { per_page: 1000 },
    );

    // admin:organizations is a management-plane permission, so it only counts
    // when granted on the Management API audience — otherwise an identically
    // named permission on an unrelated resource server would masquerade as the
    // global escape hatch (#1198).
    const hasAdminOrg = rolePermissions.some(
      (permission) =>
        permission.permission_name === "admin:organizations" &&
        permission.resource_server_identifier === MANAGEMENT_API_AUDIENCE,
    );

    if (hasAdminOrg) {
      return true;
    }
  }

  return false;
}
