import { useEffect, useState } from "react";
import { useDataProvider } from "ra-core";
import type {
  AuthHeroDataProvider,
  ConfigSyncStatus,
} from "@/auth0DataProvider";
import { useTenantId } from "@/TenantContext";

export interface ConfigSyncStatusState {
  status?: ConfigSyncStatus;
  loading: boolean;
}

/**
 * Sync status of the tenant being administered. Servers without the status
 * route (404) or callers without access (403) simply get no status, and the
 * screens fall back to what the row itself tells.
 */
export function useConfigSyncStatus(
  tenantIdOverride?: string,
  /** Change it to fetch again, e.g. after a sync ran. */
  refreshToken?: string,
): ConfigSyncStatusState {
  const contextTenantId = useTenantId();
  const tenantId = tenantIdOverride ?? contextTenantId;
  const dataProvider = useDataProvider() as AuthHeroDataProvider;
  const [state, setState] = useState<ConfigSyncStatusState>({
    loading: !!tenantId,
  });

  useEffect(() => {
    if (!tenantId) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    dataProvider
      .getConfigSyncStatus(tenantId)
      .then((status) => {
        if (!cancelled) setState({ status, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider, tenantId, refreshToken]);

  return state;
}
