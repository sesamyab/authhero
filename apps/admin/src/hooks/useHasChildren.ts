import { useGetOne } from "ra-core";
import { httpStatusOf } from "@/utils/httpStatus";

interface TenantInheritance {
  id: string;
  has_children?: boolean;
  parent_tenant_id?: string | null;
  config_sync?: string | null;
}

interface InheritanceOptions {
  /**
   * False skips the request, for a caller that knows it would be refused
   * (no `read:tenants`). The answer is then "no children".
   */
  enabled?: boolean;
}

const isForbidden = (error: unknown) => httpStatusOf(error) === 403;

function useTenantInheritance({ enabled = true }: InheritanceOptions = {}) {
  const { data, error } = useGetOne<TenantInheritance>(
    "settings",
    { id: "settings" },
    {
      enabled,
      // A refusal does not change on a retry.
      retry: (failureCount, err) => !isForbidden(err) && failureCount < 3,
    },
  );
  return { data, forbidden: !enabled || isForbidden(error) };
}

/**
 * Whether other tenants inherit from the tenant being administered (the server
 * computes `has_children` on the tenant settings). The inheritance controls
 * that only act on child tenants hide when it is `false`; while the answer is
 * loading, or from a server that does not send it, they stay visible. A caller
 * that may not read the settings (403, or `enabled: false`) has no children to
 * act on, so they hide.
 */
export function useHasChildren(options?: InheritanceOptions): boolean {
  const { data, forbidden } = useTenantInheritance(options);
  if (forbidden) return false;
  return data?.has_children !== false;
}

/**
 * Whether lists should show where a row comes from. Not when the tenant has
 * nothing below it and receives nothing from above (no parent, not synced):
 * then every row is its own and the column says nothing. Shown while loading.
 */
export function useShowInheritance(): boolean {
  const { data: tenant } = useTenantInheritance();
  if (!tenant) return true;
  return (
    tenant.has_children !== false ||
    !!tenant.parent_tenant_id ||
    tenant.config_sync === "synced"
  );
}
