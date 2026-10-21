import { Kysely, Selectable } from "kysely";
import { removeNullProperties } from "../helpers/remove-nulls";
import { parseJsonObjectIfDefined } from "../helpers/parse";
import { luceneFilter } from "../helpers/filter";
import {
  Hook,
  ListHooksResponse,
  ListParams,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { keysetPaginate, isKeysetRequest } from "../helpers/paginate";

import getCountAsInt from "../utils/getCountAsInt";
import { convertDatesToAdapter } from "../utils/dateConversion";
import { enforceFromSql } from "../utils/configInheritance";

function toHooks(hook: Selectable<Database["hooks"]>) {
  const {
    tenant_id: _tenantId,
    enabled,
    synchronous,
    created_at_ts,
    updated_at_ts,
    metadata,
    enforce,
    ...rest
  } = hook;

  const dates = convertDatesToAdapter({ created_at_ts, updated_at_ts }, [
    "created_at_ts",
    "updated_at_ts",
  ]);

  return removeNullProperties<Hook>({
    ...rest,
    ...dates,
    enabled: !!enabled,
    synchronous: !!synchronous,
    enforce: enforceFromSql(enforce),
    metadata: parseJsonObjectIfDefined(metadata),
  });
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListParams = {},
  ): Promise<ListHooksResponse> => {
    const { page = 0, per_page = 50, include_totals = false, sort, q } = params;

    let query = db.selectFrom("hooks").where("hooks.tenant_id", "=", tenant_id);

    if (q) {
      query = luceneFilter(db, query, q, [
        "url",
        "form_id",
        "template_id",
        "code_id",
      ]);
    }

    // Keyset (checkpoint) pagination: from/take. Fixed created_at_ts desc order with
    // an hook_id tiebreaker and no total, matching the other checkpoint lists.
    if (isKeysetRequest(params)) {
      const { rows, limit, next } = await keysetPaginate(
        query.selectAll(),
        params,
        { sortColumn: "created_at_ts", sortOrder: "desc", idColumn: "hook_id" },
      );
      const keysetHooks = rows.map(toHooks);
      return {
        hooks: keysetHooks,
        start: 0,
        limit,
        length: keysetHooks.length,
        next,
      };
    }

    if (sort?.sort_by) {
      const { ref } = db.dynamic;
      query = query.orderBy(ref(sort.sort_by), sort.sort_order);
    } else {
      query = query.orderBy("priority", "desc").orderBy("created_at_ts", "asc");
    }

    const filteredQuery = query.offset(page * per_page).limit(per_page);

    const results = await filteredQuery.selectAll().execute();

    const hooks = results.map(toHooks);

    if (!include_totals) {
      return {
        hooks,
        start: 0,
        limit: 0,
        length: 0,
      };
    }

    const { count } = await query
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    return {
      hooks,
      start: page * per_page,
      limit: per_page,
      length: getCountAsInt(count),
    };
  };
}
