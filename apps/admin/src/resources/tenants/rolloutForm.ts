import type { CreateRolloutInput } from "@/auth0DataProvider";

/** The root tenant select has no empty value, so "all" stands for it. */
export const ALL_TENANTS = "__all__";

export interface RolloutFormValues {
  rootTenantId: string;
  canary: string;
  /** One percentage per wave, as typed. */
  waves: string[];
  failureThreshold: string;
  dryRun: boolean;
  force: boolean;
}

export const DEFAULT_ROLLOUT_FORM: RolloutFormValues = {
  rootTenantId: ALL_TENANTS,
  canary: "1",
  waves: ["10", "50", "100"],
  failureThreshold: "10",
  dryRun: false,
  force: false,
};

/**
 * Form text -> request body. Returns an error message instead when a value
 * does not parse, so the form can show it before anything is sent.
 */
export function toCreateRolloutInput(
  values: RolloutFormValues,
): { input: CreateRolloutInput } | { error: string } {
  const canary = Number(values.canary);
  if (!Number.isInteger(canary) || canary < 0) {
    return { error: "Canary must be a whole number, 0 or more" };
  }

  const waves = values.waves
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (
    waves.length === 0 ||
    waves.some((w) => !Number.isFinite(w) || w <= 0 || w > 100) ||
    waves.some((w, i) => i > 0 && w <= waves[i - 1]!)
  ) {
    return { error: "Waves must be ascending percentages between 1 and 100" };
  }

  const threshold = Number(values.failureThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return { error: "Failure threshold must be a percentage from 0 to 100" };
  }

  const root =
    values.rootTenantId === ALL_TENANTS ? "" : values.rootTenantId.trim();
  return {
    input: {
      ...(root ? { root_tenant_id: root } : {}),
      canary,
      waves,
      failure_threshold: threshold / 100,
      ...(values.dryRun ? { dry_run: true } : {}),
      ...(values.force ? { force: true } : {}),
    },
  };
}
