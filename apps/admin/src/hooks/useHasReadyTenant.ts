import { useGetList } from "ra-core";
import { isReadyTenant } from "@/utils/tenantState";

// Enough to find a ready tenant among the first ones a user sees; a user with
// more than this many tenants has used the product before.
const READY_CHECK_PAGE_SIZE = 50;

/**
 * Whether the user has a tenant they can open. Only asked outside a tenant
 * (the tenants view, `tenantId` unset): inside one there is always the
 * current tenant, and the data provider there is scoped to it. A user whose
 * only tenants are still being set up, or failed to be, is onboarding: there
 * is nowhere to navigate to, so the layout leaves navigation out.
 *
 * Read through the tenants query, so it follows the list as it changes, for
 * example after a tenant is created. Undefined until the list answers; a
 * failed request keeps navigation, which still offers "Manage tenants".
 */
export function useHasReadyTenant(
  tenantId: string | undefined,
): boolean | undefined {
  const { data, error, isPending } = useGetList<{
    id: string;
    provisioning_state?: string | null;
  }>(
    "tenants",
    {
      pagination: { page: 1, perPage: READY_CHECK_PAGE_SIZE },
      sort: { field: "id", order: "ASC" },
    },
    // A failure only means navigation stays; no point in retrying for it.
    { enabled: !tenantId, retry: false },
  );
  if (tenantId) return true;
  if (error) return true;
  if (isPending) return undefined;
  return (data ?? []).some(isReadyTenant);
}
