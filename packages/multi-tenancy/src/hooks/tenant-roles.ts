import { MANAGEMENT_API_AUDIENCE, MANAGEMENT_API_SCOPES } from "authhero";
import type { DataAdapters, Role } from "authhero";

/** Default name of the role an operator who creates a tenant gets in it. */
export const DEFAULT_ADMIN_ROLE_NAME = "Tenant Admin";

/** Default name of the role a self-service creator gets in their tenant. */
export const DEFAULT_OWNER_ROLE_NAME = "Tenant Owner";

/**
 * Management scopes a tenant owner never gets. They act on the control plane
 * or across tenants, so they stay with operators (the "Tenant Admin" role):
 * creating or deleting tenants, administering or entering every organization,
 * fleet-wide rollouts, and tenant operations (a self-service user gets the narrow
 * `read:tenant_operations` / `retry:tenant_provisioning` from the global
 * self-service role instead).
 */
export const OPERATOR_ONLY_SCOPES: readonly string[] = [
  "create:tenants",
  "delete:tenants",
  "admin:organizations",
  "access:all_organizations",
  "read:rollouts",
  "create:rollouts",
  "update:rollouts",
  "read:tenant_operations",
  "create:tenant_operations",
];

/**
 * The operator-only scopes that only make sense across organizations. A creator
 * who holds `admin:organizations` is not added to the tenant's organization at
 * all, so these two cannot be what decides which role a creator gets.
 */
const ORGANIZATION_SPANNING_SCOPES: readonly string[] = [
  "admin:organizations",
  "access:all_organizations",
];

/**
 * What a creator must already hold globally to get the admin role: every
 * operator-only scope that is not organization-spanning. The admin role is the
 * owner role plus the operator-only scopes, so this keeps the role in the
 * tenant's organization from granting more than the creator already had.
 */
export const ADMIN_REQUIRES_SCOPES: readonly string[] =
  OPERATOR_ONLY_SCOPES.filter(
    (scope) => !ORGANIZATION_SPANNING_SCOPES.includes(scope),
  );

/**
 * The Management API permissions a user holds globally (not in an
 * organization), from their global roles and from permissions given to them
 * directly.
 */
export async function globalManagementPermissions(
  data: DataAdapters,
  tenantId: string,
  userId: string,
): Promise<Set<string>> {
  const held = new Set<string>();
  const roles = await data.userRoles.list(tenantId, userId, undefined, "");
  for (const role of roles) {
    const granted = await data.rolePermissions.list(tenantId, role.id, {
      per_page: 1000,
    });
    for (const permission of granted) {
      if (permission.resource_server_identifier === MANAGEMENT_API_AUDIENCE) {
        held.add(permission.permission_name);
      }
    }
  }
  const direct = await data.userPermissions.list(
    tenantId,
    userId,
    { per_page: 1000 },
    "",
  );
  for (const permission of direct) {
    if (permission.resource_server_identifier === MANAGEMENT_API_AUDIENCE) {
      held.add(permission.permission_name);
    }
  }
  return held;
}

/**
 * Every management scope except the operator-only ones. A scope added to
 * `MANAGEMENT_API_SCOPES` later reaches owners unless it is listed above, so
 * a test freezes this list and a new scope has to be placed on purpose.
 */
export function tenantOwnerScopes(): string[] {
  return MANAGEMENT_API_SCOPES.map((scope) => scope.value).filter(
    (value) => !OPERATOR_ONLY_SCOPES.includes(value),
  );
}

/**
 * Finds a role by name across every page of roles (adapters default to 50 a
 * page). With duplicates the lowest id wins, so concurrent callers agree.
 */
export async function findRoleByName(
  data: DataAdapters,
  tenantId: string,
  name: string,
): Promise<Role | undefined> {
  const perPage = 100;
  const matches: Role[] = [];
  for (let page = 0; ; page++) {
    const { roles } = await data.roles.list(tenantId, {
      page,
      per_page: perPage,
    });
    matches.push(...roles.filter((role) => role.name === name));
    if (roles.length < perPage) break;
  }
  return matches.sort((a, b) => a.id.localeCompare(b.id))[0];
}

/**
 * Gets or creates a role and makes sure it carries every scope in `scopes` on
 * the Management API. Permissions already on the role, including ones an
 * operator added, are never removed, so a role created before a scope existed
 * picks it up. Returns the role id.
 */
export async function ensureRoleWithScopes(
  data: DataAdapters,
  tenantId: string,
  role: { name: string; description: string; scopes: readonly string[] },
): Promise<string> {
  const existing =
    (await findRoleByName(data, tenantId, role.name)) ??
    (await data.roles.create(tenantId, {
      name: role.name,
      description: role.description,
    }));

  const granted = await data.rolePermissions.list(tenantId, existing.id, {
    per_page: 1000,
  });
  const missing = role.scopes.filter(
    (scope) =>
      !granted.some(
        (permission) =>
          permission.permission_name === scope &&
          permission.resource_server_identifier === MANAGEMENT_API_AUDIENCE,
      ),
  );
  if (missing.length) {
    await data.rolePermissions.assign(
      tenantId,
      existing.id,
      missing.map((scope) => ({
        role_id: existing.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: scope,
      })),
    );
  }
  return existing.id;
}
