import { HTTPException } from "hono/http-exception";

/**
 * Default maximum number of ancestors a tenant may have. The tree is limited
 * to two levels above a tenant to begin with, but callers pass the limit so it
 * is not hard-coded in the model (docs/design/tenant-config-inheritance.md,
 * section 3.1).
 */
export const DEFAULT_MAX_TENANT_DEPTH = 2;

/**
 * Validates `parent_tenant_id` for a tenant that is being created or
 * re-parented. Throws a 400 when the parent does not exist, when the new
 * parent would create a cycle, or when the resulting chain of ancestors is
 * longer than `maxDepth`.
 *
 * Pure with respect to storage: ancestors are read through `getTenant`.
 * The parent decides which config a tenant inherits (see `resolveTenantChain`);
 * this keeps the stored tree valid.
 */
export async function validateTenantParent(params: {
  tenantId: string | undefined;
  parentTenantId: string | null | undefined;
  getTenant: (
    id: string,
  ) => Promise<{ id: string; parent_tenant_id?: string | null } | null>;
  /**
   * Returns the ids of a tenant's direct children. When given, the subtree
   * below `tenantId` is validated too: re-parenting pushes every descendant
   * down, so each resulting chain must still fit within `maxDepth`.
   */
  getChildren?: (id: string) => Promise<string[]>;
  maxDepth?: number;
}): Promise<void> {
  const { tenantId, parentTenantId, getTenant, getChildren } = params;
  const maxDepth = params.maxDepth ?? DEFAULT_MAX_TENANT_DEPTH;

  if (!parentTenantId) return;

  if (tenantId && parentTenantId === tenantId) {
    throw new HTTPException(400, {
      message: "A tenant cannot be its own parent",
    });
  }

  const seen = new Set<string>(tenantId ? [tenantId] : []);
  let depth = 0;
  let currentId: string | null | undefined = parentTenantId;

  while (currentId) {
    if (seen.has(currentId)) {
      throw new HTTPException(400, {
        message: `Setting parent_tenant_id to '${parentTenantId}' would create a cycle`,
      });
    }
    seen.add(currentId);

    const current = await getTenant(currentId);
    if (!current) {
      throw new HTTPException(400, {
        message: `Parent tenant '${currentId}' not found`,
      });
    }

    depth += 1;
    if (depth > maxDepth) {
      throw new HTTPException(400, {
        message: `Tenant tree is limited to ${maxDepth} levels above a tenant`,
      });
    }
    currentId = current.parent_tenant_id;
  }

  if (tenantId && getChildren) {
    // `depth` is now the number of ancestors the tenant will have. A descendant
    // `level` steps below it has `depth + level` ancestors.
    const visited = new Set<string>([tenantId]);
    let level = 0;
    let frontier = [tenantId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const childId of await getChildren(id)) {
          if (visited.has(childId)) continue;
          visited.add(childId);
          next.push(childId);
        }
      }
      if (next.length > 0) {
        level += 1;
        if (depth + level > maxDepth) {
          throw new HTTPException(400, {
            message: `Moving tenant under '${parentTenantId}' would make its descendant '${next[0]}' exceed the tenant tree limit of ${maxDepth} levels`,
          });
        }
      }
      frontier = next;
    }
  }
}
