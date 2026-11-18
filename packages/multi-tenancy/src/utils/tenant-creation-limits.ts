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
  /** Owned tenants still provisioning. */
  pending: string[];
}

type UsageArgs = {
  limits: TenantCreationLimitsConfig | undefined;
  data: DataAdapters;
  controlPlaneTenantId: string | undefined;
  ownerRoleName?: string;
  user: { sub: string };
};

/**
 * The user's cap and how many tenants they own. Throws on a read failure, and
 * when the owned count cannot be proven complete.
 */
async function resolveTenantCreationUsage(
  args: UsageArgs & { limits: TenantCreationLimitsConfig },
  controlPlaneTenantId: string,
): Promise<TenantCreationUsage & { blockWhilePending: boolean }> {
  const { limits, data, user } = args;
  const ownerRoleName = args.ownerRoleName ?? DEFAULT_OWNER_ROLE_NAME;

  // Resolve the cap: a per-user override wins over the configured value.
  const fromMetadata = parseMetadataLimit(
    (await data.users.get(controlPlaneTenantId, user.sub))?.app_metadata,
  );
  let cap: number | null | undefined;
  let source: TenantLimitSource;
  if (fromMetadata.set) {
    cap = fromMetadata.value;
    source = "override";
  } else if (typeof limits.perUser === "function") {
    cap = await limits.perUser({ user_id: user.sub });
    source = "default";
  } else {
    cap = limits.perUser;
    source = "default";
  }
  if (cap === undefined || cap === null) {
    source = fromMetadata.set ? "override" : "none";
  }
  const blockWhilePending = limits.blockWhilePending ?? true;

  // Tenants the user owns: organizations they belong to where they hold the
  // owner role. The organization name is the tenant id.
  const owned: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { organizations } =
      await data.userOrganizations.listUserOrganizations(
        controlPlaneTenantId,
        user.sub,
        { page, per_page: PAGE_SIZE },
      );
    for (const org of organizations) {
      const roles = await data.userRoles.list(
        controlPlaneTenantId,
        user.sub,
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
      throw new HTTPException(503, {
        message: "Could not check the tenant creation limit. Try again later.",
      });
    }
  }

  const pending: string[] = [];
  if (blockWhilePending) {
    for (const tenantId of owned) {
      const tenant = await data.tenants.get(tenantId);
      if (tenant?.provisioning_state === "pending") pending.push(tenantId);
    }
  }

  return {
    key: "tenants_per_user",
    used: owned.length,
    limit: cap ?? null,
    source,
    pending,
    blockWhilePending,
  };
}

/**
 * What the user may be shown about their own creation limit: tenants used and
 * the cap, with where the cap comes from. Throws 503 if it cannot be read.
 */
export async function getTenantCreationUsage(
  args: UsageArgs,
): Promise<TenantCreationUsage> {
  const { limits, controlPlaneTenantId } = args;
  if (!limits || !controlPlaneTenantId) {
    return {
      key: "tenants_per_user",
      used: 0,
      limit: null,
      source: "none",
      pending: [],
    };
  }
  try {
    const { blockWhilePending: _b, ...usage } =
      await resolveTenantCreationUsage(
        { ...args, limits },
        controlPlaneTenantId,
      );
    return usage;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("Could not read tenant creation usage:", error);
    throw new HTTPException(503, {
      message: "Could not check the tenant creation limit. Try again later.",
    });
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
  const { limits, controlPlaneTenantId } = args;
  if (!limits || !controlPlaneTenantId) return;

  try {
    const blockWhilePending = limits.blockWhilePending ?? true;
    // Nothing to check without a cap or the pending rule: skip the reads.
    const probe = await resolveTenantCreationUsage(
      { ...args, limits },
      controlPlaneTenantId,
    );
    if (probe.limit === null && !blockWhilePending) return;

    if (probe.limit !== null && probe.used >= probe.limit) {
      throw new HTTPException(403, {
        message: `Tenant limit reached: you can own at most ${probe.limit} tenant${probe.limit === 1 ? "" : "s"}. Contact an administrator to raise the limit.`,
      });
    }
    if (probe.pending.length > 0) {
      throw new HTTPException(403, {
        message: `Tenant '${probe.pending[0]}' is still being set up. Wait until it is ready before creating another.`,
      });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("Could not check tenant creation limits:", error);
    throw new HTTPException(503, {
      message: "Could not check the tenant creation limit. Try again later.",
    });
  }
}
