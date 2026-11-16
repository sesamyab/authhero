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
