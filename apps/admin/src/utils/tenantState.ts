/**
 * Whether a tenant can be opened: provisioned and not failed. Tenants from
 * before provisioning states existed have none, and are ready.
 */
export function isReadyTenant(tenant: {
  provisioning_state?: string | null;
}): boolean {
  return (tenant.provisioning_state ?? "ready") === "ready";
}
