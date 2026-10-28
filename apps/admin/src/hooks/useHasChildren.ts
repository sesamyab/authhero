import { useGetOne } from "ra-core";

interface TenantInheritance {
  id: string;
  has_children?: boolean;
  parent_tenant_id?: string | null;
  config_sync?: string | null;
}

function useTenantInheritance() {
  return useGetOne<TenantInheritance>("settings", { id: "settings" }).data;
}

/**
 * Whether other tenants inherit from the tenant being administered (the server
 * computes `has_children` on the tenant settings). The inheritance controls
 * that only act on child tenants hide when it is `false`; while the answer is
 * loading, or from a server that does not send it, they stay visible.
 */
export function useHasChildren(): boolean {
  return useTenantInheritance()?.has_children !== false;
}

/**
 * Whether lists should show where a row comes from. Not when the tenant has
 * nothing below it and receives nothing from above (no parent, not synced):
 * then every row is its own and the column says nothing. Shown while loading.
 */
export function useShowInheritance(): boolean {
  const tenant = useTenantInheritance();
  if (!tenant) return true;
  return (
    tenant.has_children !== false ||
    !!tenant.parent_tenant_id ||
    tenant.config_sync === "synced"
  );
}
