import type { TenantsDataAdapter } from "@authhero/adapter-interfaces";

const PAGE_SIZE = 100;

/**
 * The id of an existing tenant that differs from `id` only in letter case, if
 * there is one.
 *
 * An organization name reaches a token in lowercase, and the platform matches
 * it against a tenant id ignoring case (tenants with capitals exist). Two
 * tenants whose ids differ only in case are therefore indistinguishable by their
 * members' tokens: a member of `ACME` would also pass for `acme`. The exact
 * duplicate check of the adapters does not catch this, and a `LIKE` search
 * depends on the database's collation, so this reads the tenants and compares
 * lowercased ids.
 *
 * An identical id is not a collision here: the adapter refuses that itself.
 *
 * This is a check before the insert, not a constraint: two requests creating
 * `ACME` and `acme` at the same moment, neither existing yet, can both pass.
 * What it stops is the case that matters, a new id colliding with a tenant that
 * already exists.
 */
export async function findCaseCollidingTenantId(
  tenants: Pick<TenantsDataAdapter, "list">,
  id: string,
): Promise<string | undefined> {
  const lowered = id.toLowerCase();
  for (let page = 0; ; page++) {
    // Sorted by id so the pages are stable: without an order a database may
    // return rows in a different sequence per page and skip some.
    const { tenants: batch } = await tenants.list({
      page,
      per_page: PAGE_SIZE,
      sort: { sort_by: "id", sort_order: "asc" },
    });
    const hit = batch.find(
      (tenant) => tenant.id !== id && tenant.id.toLowerCase() === lowered,
    );
    if (hit) return hit.id;
    if (batch.length < PAGE_SIZE) return undefined;
  }
}
