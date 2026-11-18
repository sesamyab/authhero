import { HTTPException } from "hono/http-exception";
import type { DataAdapters } from "authhero";
import type { TenantCreationLimitsConfig } from "../types";
import { DEFAULT_OWNER_ROLE_NAME } from "../hooks/tenant-roles";

/** The `app_metadata` field an operator sets to raise (or lift) one user's cap. */
export const TENANT_LIMIT_METADATA_KEY = "tenant_limit";

const PAGE_SIZE = 100;
// A user cannot reasonably own this many tenants; stops a runaway loop if an
// adapter ignores `page`.
const MAX_PAGES = 50;

/**
 * Whether the token carries the scopes only an operator has. A self-service
 * creator holds `create:tenants` alone, and their token is from the control
 * plane too, so "is a control plane token" is not enough to exempt a caller.
 */
export function callerIsOperator(user: unknown, orgScoped = false): boolean {
  // An organization-scoped token acts for one tenant's organization; its
  // scopes come from an org role, so it is never the operator exemption.
  if (orgScoped) return false;
  if (!user || typeof user !== "object") return false;
  const { permissions, scope } = user as {
    permissions?: unknown;
    scope?: unknown;
  };
  const granted = new Set<string>([
    ...(Array.isArray(permissions)
      ? permissions.filter((p): p is string => typeof p === "string")
      : []),
    ...(typeof scope === "string" ? scope.split(" ").filter(Boolean) : []),
  ]);
  return [
    "delete:tenants",
    "admin:organizations",
    "create:tenant_operations",
    "create:rollouts",
  ].some((s) => granted.has(s));
}

function parseMetadataLimit(
  appMetadata: unknown,
): { set: true; value: number | null } | { set: false } {
  if (!appMetadata || typeof appMetadata !== "object") return { set: false };
  const raw = (appMetadata as Record<string, unknown>)[
    TENANT_LIMIT_METADATA_KEY
  ];
  // `null` is not usable: a metadata update treats it as "remove the key".
  if (raw === "unlimited") return { set: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { set: true, value: raw };
  }
  return { set: false };
}

/** Where a limit's value comes from. */
export type TenantLimitSource = "override" | "default" | "none";

export interface TenantCreationUsage {
  /** Stable key, the shape the entitlements port will use for every limit. */
  key: "tenants_per_user";
  used: number;
  /** `null` is unlimited. */
  limit: number | null;
  source: TenantLimitSource;
}

type UsageArgs = {
  limits: TenantCreationLimitsConfig | undefined;
  data: DataAdapters;
  controlPlaneTenantId: string | undefined;
  ownerRoleName?: string;
  user: { sub: string };
};

const UNAVAILABLE =
  "Could not check the tenant creation limit. Try again later.";

/** The user's cap: a per-user override wins over the configured value. */
async function resolveCap(
  limits: TenantCreationLimitsConfig,
  data: DataAdapters,
  controlPlaneTenantId: string,
  userId: string,
): Promise<{ cap: number | null; source: TenantLimitSource }> {
  const fromMetadata = parseMetadataLimit(
    (await data.users.get(controlPlaneTenantId, userId))?.app_metadata,
  );
  if (fromMetadata.set) {
    return { cap: fromMetadata.value, source: "override" };
  }
  const cap =
    typeof limits.perUser === "function"
      ? await limits.perUser({ user_id: userId })
      : limits.perUser;
  return cap === undefined || cap === null
    ? { cap: null, source: "none" }
    : { cap, source: "default" };
}

/**
 * Tenants the user owns: organizations they belong to where they hold the
 * owner role. The organization name is the tenant id. Throws when the list
 * cannot be proven complete.
 */
async function listOwnedTenants(
  data: DataAdapters,
  controlPlaneTenantId: string,
  userId: string,
  ownerRoleName: string,
): Promise<string[]> {
  const owned: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { organizations } =
      await data.userOrganizations.listUserOrganizations(
        controlPlaneTenantId,
        userId,
        { page, per_page: PAGE_SIZE },
      );
    for (const org of organizations) {
      const roles = await data.userRoles.list(
        controlPlaneTenantId,
        userId,
        undefined,
        org.id,
      );
      if (roles.some((role) => role.name === ownerRoleName)) {
        owned.push(org.name);
      }
    }
    if (organizations.length < PAGE_SIZE) break;
    // A full last page means the list may continue: the count is not proven
    // complete, so fail closed rather than compare a prefix to the cap.
    if (page === MAX_PAGES - 1) {
      throw new HTTPException(503, { message: UNAVAILABLE });
    }
  }
  return owned;
}

/**
 * What the user may be shown about their own creation limit: tenants used and
 * the cap, with where the cap comes from. Throws 503 if it cannot be read.
 * Provisioning state plays no part here, so it is not read.
 */
export async function getTenantCreationUsage(
  args: UsageArgs,
): Promise<TenantCreationUsage> {
  const { limits, data, controlPlaneTenantId, user } = args;
  if (!limits || !controlPlaneTenantId) {
    return { key: "tenants_per_user", used: 0, limit: null, source: "none" };
  }
  try {
    const { cap, source } = await resolveCap(
      limits,
      data,
      controlPlaneTenantId,
      user.sub,
    );
    const owned = await listOwnedTenants(
      data,
      controlPlaneTenantId,
      user.sub,
      args.ownerRoleName ?? DEFAULT_OWNER_ROLE_NAME,
    );
    return { key: "tenants_per_user", used: owned.length, limit: cap, source };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("Could not read tenant creation usage:", error);
    throw new HTTPException(503, { message: UNAVAILABLE });
  }
}

/**
 * Enforces `tenantCreationLimits` for a non-operator creating a tenant.
 *
 * Throws 403 when the user owns as many tenants as their limit allows, or
 * still has one provisioning. Throws 503 if the counts cannot be read: this is
 * a cost guard, so it fails closed.
 */
export async function enforceTenantCreationLimits(
  args: UsageArgs,
): Promise<void> {
  const { limits, data, controlPlaneTenantId, user } = args;
  if (!limits || !controlPlaneTenantId) return;

  try {
    const { cap } = await resolveCap(
      limits,
      data,
      controlPlaneTenantId,
      user.sub,
    );
    const blockWhilePending = limits.blockWhilePending ?? true;
    // Neither rule applies: nothing to count.
    if (cap === null && !blockWhilePending) return;

    const owned = await listOwnedTenants(
      data,
      controlPlaneTenantId,
      user.sub,
      args.ownerRoleName ?? DEFAULT_OWNER_ROLE_NAME,
    );

    // The count alone decides this: no need to read provisioning state.
    if (cap !== null && owned.length >= cap) {
      throw new HTTPException(403, {
        message: `Tenant limit reached: you can own at most ${cap} tenant${cap === 1 ? "" : "s"}. Contact an administrator to raise the limit.`,
      });
    }

    if (blockWhilePending) {
      for (const tenantId of owned) {
        const tenant = await data.tenants.get(tenantId);
        if (tenant?.provisioning_state === "pending") {
          throw new HTTPException(403, {
            message: `Tenant '${tenantId}' is still being set up. Wait until it is ready before creating another.`,
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("Could not check tenant creation limits:", error);
    throw new HTTPException(503, { message: UNAVAILABLE });
  }
}
