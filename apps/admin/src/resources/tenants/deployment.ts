import { useCallback, useEffect, useState } from "react";
import { useDataProvider } from "ra-core";
import type {
  AuthHeroDataProvider,
  TenantCreationLimit,
  TenantDeploymentOptions,
} from "@/auth0DataProvider";

/**
 * What the create form and the setup page share about where a new tenant
 * lives: the deployment options the server offers, the id rules and the
 * hostname a tenant gets.
 */

// What a server without the deployment-options endpoint allows.
const legacyDeploymentOptions: TenantDeploymentOptions = {
  deployment_types: ["shared", "wfp"],
  default_deployment_type: "shared",
};

// Asks the server which deployment types it can host, so a cluster without a
// shared database (WFP only) doesn't offer "shared", and which hostname a new
// tenant gets.
export function useDeploymentOptions(): TenantDeploymentOptions | undefined {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const [options, setOptions] = useState<TenantDeploymentOptions>();

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getTenantDeploymentOptions()
      .then((result) => {
        if (!cancelled) setOptions(result ?? legacyDeploymentOptions);
      })
      .catch(() => {
        // The server still enforces what it allows; fall back to the choice.
        if (!cancelled) setOptions(legacyDeploymentOptions);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  return options;
}

// One lowercase DNS label, as the id becomes the tenant's hostname on
// subdomain deployments. The server decides the rest (taken, reserved).
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateTenantId(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (!DNS_LABEL.test(value)) {
    return "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit (at most 63).";
  }
  return undefined;
}

/** The hostname for `id` from the server's template (`{id}.example.com`). */
export function tenantHost(template: string, id: string): string {
  return template.split("{id}").join(id || "your-id");
}

/**
 * The caller's creation limit, or `undefined` while loading and when there is
 * nothing to show (an old server, or a caller the endpoint refuses). The
 * server enforces it either way.
 */
export function useTenantCreationLimit(): [
  TenantCreationLimit | undefined,
  /** Ask again, e.g. after the server refused a create. */
  () => void,
] {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const [limit, setLimit] = useState<TenantCreationLimit>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getTenantCreationLimit()
      .then((result) => {
        if (!cancelled && result) setLimit(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataProvider, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return [limit, refresh];
}

/** "2 of 3 tenants used", or nothing when there is no cap. */
export function describeCreationLimit(
  limit: TenantCreationLimit | undefined,
): string | undefined {
  if (!limit || limit.limit === null) return undefined;
  return `${limit.used} of ${limit.limit} tenant${limit.limit === 1 ? "" : "s"} used`;
}

export function creationLimitReached(
  limit: TenantCreationLimit | undefined,
): boolean {
  return !!limit && limit.limit !== null && limit.used >= limit.limit;
}
