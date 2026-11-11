import type {
  TenantDeploymentType,
  TenantDeploymentTypesConfig,
} from "../types";

export interface ResolvedDeploymentTypes {
  allowed: TenantDeploymentType[];
  default: TenantDeploymentType;
}

const ALL_DEPLOYMENT_TYPES: TenantDeploymentType[] = ["shared", "wfp"];

/**
 * Fills in the defaults for `deploymentTypes` and checks it, so a cluster
 * misconfiguration fails at startup rather than on the first tenant create.
 */
export function resolveDeploymentTypes(
  config: TenantDeploymentTypesConfig | undefined,
): ResolvedDeploymentTypes {
  if (!config) {
    return { allowed: ALL_DEPLOYMENT_TYPES, default: "shared" };
  }

  const allowed = [...new Set(config.allowed)];
  const first = allowed[0];
  if (!first) {
    throw new Error("deploymentTypes.allowed must name at least one type");
  }
  const defaultType = config.default ?? first;
  if (!allowed.includes(defaultType)) {
    throw new Error(
      `deploymentTypes.default '${defaultType}' is not in deploymentTypes.allowed`,
    );
  }
  return { allowed, default: defaultType };
}
