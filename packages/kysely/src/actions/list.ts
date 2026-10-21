import { Kysely, Selectable } from "kysely";
import { Action, ListParams } from "@authhero/adapter-interfaces";
import { ListActionsResponse } from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { keysetPaginate, isKeysetRequest } from "../helpers/paginate";

import { luceneFilter } from "../helpers/filter";
import getCountAsInt from "../utils/getCountAsInt";
import { convertDatesToAdapter } from "../utils/dateConversion";
import { enforceFromSql } from "../utils/configInheritance";

function parseJsonField<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toActions(row: Selectable<Database["actions"]>) {
  const {
    created_at_ts,
    updated_at_ts,
    deployed_at_ts,
    secrets,
    dependencies,
    supported_triggers,
    is_system,
    inherit,
    scope,
    override,
    enforce,
    tenant_id: _tenantId,
    ...rest
  } = row;

  const dates = convertDatesToAdapter({ created_at_ts, updated_at_ts }, [
    "created_at_ts",
    "updated_at_ts",
  ]);

  return {
    ...rest,
    tenant_id: _tenantId,
    ...dates,
    runtime: rest.runtime ?? undefined,
    status: (rest.status as "draft" | "built") || "built",
    deployed_at: deployed_at_ts
      ? new Date(Number(deployed_at_ts)).toISOString()
      : undefined,
    secrets: parseJsonField<Array<{ name: string; value?: string }>>(secrets),
    dependencies:
      parseJsonField<Array<{ name: string; version: string }>>(dependencies),
    supported_triggers:
      parseJsonField<Array<{ id: string; version?: string }>>(
        supported_triggers,
      ),
    is_system: !!is_system,
    inherit: !!inherit,
    scope: scope ?? undefined,
    override: override ?? undefined,
    enforce: enforceFromSql(enforce),
  } as Action;
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListParams = {},
  ): Promise<ListActionsResponse> => {
    const { page = 0, per_page = 50, include_totals = false, q } = params;

    let query = db
      .selectFrom("actions")
      .where("actions.tenant_id", "=", tenant_id);

    if (q) {
      query = luceneFilter(db, query, q, ["name"]);
    }

    // Keyset (checkpoint) pagination: from/take. Fixed created_at_ts desc order with
    // an id tiebreaker and no total, matching the other checkpoint lists.
    if (isKeysetRequest(params)) {
      const { rows, limit, next } = await keysetPaginate(
        query.selectAll(),
        params,
        { sortColumn: "created_at_ts", sortOrder: "desc", idColumn: "id" },
      );
      const keysetActions = rows.map(toActions);
      return {
        actions: keysetActions,
        start: 0,
        limit,
        length: keysetActions.length,
        next,
      };
    }

    const filteredQuery = query.offset(page * per_page).limit(per_page);

    const results = await filteredQuery.selectAll().execute();

    const actions = results.map(toActions);

    if (!include_totals) {
      // No count query is run, so `length` reports the size of this page
      // rather than the total. `start`/`limit` still describe the window that
      // was requested, matching the `include_totals` branch below.
      return {
        actions,
        start: page * per_page,
        limit: per_page,
        length: actions.length,
      };
    }

    const { count } = await query
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    return {
      actions,
      start: page * per_page,
      limit: per_page,
      length: getCountAsInt(count),
    };
  };
}
