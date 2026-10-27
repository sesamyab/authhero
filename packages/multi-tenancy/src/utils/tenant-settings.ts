import { TenantsDataAdapter } from "@authhero/adapter-interfaces";

/**
 * The computed fields the settings routes add to the tenant (not persisted):
 * `is_control_plane`, and `has_children`, true when another tenant inherits
 * from it. Every other tenant sits below the control plane (a tenant without a
 * parent inherits from it), so the control plane has children as soon as it is
 * not alone; any other tenant needs a tenant that names it as its parent.
 */
export async function computedTenantFields(
  tenants: TenantsDataAdapter,
  tenantId: string,
  controlPlaneTenantId: string | undefined,
): Promise<{ is_control_plane: boolean; has_children: boolean }> {
  const isControlPlane =
    !controlPlaneTenantId || controlPlaneTenantId === tenantId;
  const { totals } = await tenants.list({
    per_page: 1,
    include_totals: true,
    ...(isControlPlane ? {} : { q: `parent_tenant_id:${tenantId}` }),
  });
  return {
    is_control_plane: isControlPlane,
    has_children: (totals?.length ?? 0) > (isControlPlane ? 1 : 0),
  };
}
