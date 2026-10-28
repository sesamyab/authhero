import { Kysely, Selectable } from "kysely";
import { formSchema, ListFormsResponse } from "@authhero/adapter-interfaces";
import { ListParams } from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { keysetPaginate, isKeysetRequest } from "../helpers/paginate";

import { luceneFilter } from "../helpers/filter";
import getCountAsInt from "../utils/getCountAsInt";
import { removeNullProperties } from "../helpers/remove-nulls";

function toForms(result: Selectable<Database["forms"]>) {
  const parsed = { ...result };
  if (typeof parsed.nodes === "string") {
    try {
      parsed.nodes = JSON.parse(parsed.nodes);
    } catch {}
  }
  if (typeof parsed.start === "string") {
    try {
      parsed.start = JSON.parse(parsed.start);
    } catch {}
  }
  if (typeof parsed.ending === "string") {
    try {
      parsed.ending = JSON.parse(parsed.ending);
    } catch {}
  }
  return formSchema.parse(removeNullProperties(parsed));
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListParams = {},
  ): Promise<ListFormsResponse> => {
    const { page = 0, per_page = 50, include_totals = false, q } = params;

    // Start building the query
    let query = db.selectFrom("forms").where("tenant_id", "=", tenant_id);

    // Apply any filters from the params
    if (q) {
      query = luceneFilter(db, query, q, ["name"]);
    }

    // Keyset (checkpoint) pagination: from/take. Fixed created_at desc order with
    // an id tiebreaker and no total, matching the other checkpoint lists.
    if (isKeysetRequest(params)) {
      const { rows, limit, next } = await keysetPaginate(
        query.selectAll(),
        params,
        { sortColumn: "created_at", sortOrder: "desc", idColumn: "id" },
      );
      const keysetForms = rows.map(toForms);
      return {
        forms: keysetForms,
        start: 0,
        limit,
        length: keysetForms.length,
        next,
      };
    }

    const filteredQuery = query.offset(page * per_page).limit(per_page);

    // Execute the query
    const results = await filteredQuery.selectAll().execute();

    // Parse JSON columns or stringified JSON for each result
    const forms = results.map(toForms);

    if (!include_totals) {
      return {
        forms,
        start: 0,
        limit: 0,
        length: 0,
      };
    }

    const { count } = await query
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    return {
      forms,
      start: page * per_page,
      limit: per_page,
      length: getCountAsInt(count),
    };
  };
}
