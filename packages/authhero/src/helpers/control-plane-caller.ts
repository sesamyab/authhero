type CallerUser = { tenant_id?: string; org_id?: string; org_name?: string };

/**
 * True when the caller's token comes from the control plane (or the deployment
 * is single-tenant, which is effectively a control plane). Organization-scoped
 * tokens are tenant-level credentials and do not count.
 */
export function callerIsControlPlane(ctx: {
  env: { data: { multiTenancyConfig?: { controlPlaneTenantId?: string } } };
  var: object;
}): boolean {
  const cpId = ctx.env.data.multiTenancyConfig?.controlPlaneTenantId;
  if (!cpId) return true;
  const vars = ctx.var as {
    user?: CallerUser;
    organization_id?: string;
    org_name?: string;
  };
  const user = vars.user;
  if (!user) return false;
  const orgScoped = Boolean(
    user.org_id ?? vars.organization_id ?? vars.org_name ?? user.org_name,
  );
  return !orgScoped && (!user.tenant_id || user.tenant_id === cpId);
}
