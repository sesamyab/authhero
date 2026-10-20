import { ListParams, ListGrantsResponse } from "@authhero/adapter-interfaces";
import { Kysely, Selectable } from "kysely";
import { luceneFilter } from "../helpers/filter";
import { Database } from "../db";
import getCountAsInt from "../utils/getCountAsInt";
import { keysetPaginate, isKeysetRequest } from "../helpers/paginate";

function toGrant(row: Selectable<Database["grants"]>) {
  return {
    id: row.id,
    user_id: row.user_id,
    clientID: row.client_id,
    audience: row.audience || undefined,
    scope: row.scope ? JSON.parse(row.scope) : [],
  };
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListParams = {},
  ): Promise<ListGrantsResponse> => {
    const { page = 0, per_page = 50, include_totals = false, sort, q } = params;

    let query = db
      .selectFrom("grants")
      .where("grants.tenant_id", "=", tenant_id);

    if (q) {
      query = luceneFilter(db, query, q, ["user_id", "client_id", "audience"]);
    }

    // Keyset (checkpoint) pagination: from/take. Fixed created_at desc order
    // with an id tiebreaker and no total, matching the other checkpoint lists.
    if (isKeysetRequest(params)) {
      const { rows, limit, next } = await keysetPaginate(
        query.selectAll(),
        params,
        { sortColumn: "created_at", sortOrder: "desc", idColumn: "id" },
      );
      const keysetGrants = rows.map(toGrant);
      return {
        grants: keysetGrants,
        start: 0,
        limit,
        length: keysetGrants.length,
        next,
      };
    }

    let filteredQuery = query;
    if (sort && sort.sort_by) {
      const { ref } = db.dynamic;
      filteredQuery = filteredQuery.orderBy(ref(sort.sort_by), sort.sort_order);
    }
    filteredQuery = filteredQuery.offset(page * per_page).limit(per_page);

    const rows = await filteredQuery.selectAll().execute();
    const grants = rows.map(toGrant);

    if (!include_totals) {
      return { grants, start: 0, limit: 0, length: 0 };
    }

    const { count } = await query
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    return {
      grants,
      start: page * per_page,
      limit: per_page,
      length: getCountAsInt(count),
    };
  };
}
